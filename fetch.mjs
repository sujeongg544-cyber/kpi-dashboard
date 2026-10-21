// 오늘의공고 웹사이트 KPI — GA4 BigQuery → docs/data/kpi.json
//
// 모수: 아래 KEYWORDS 중 하나라도 UTM(source|medium|campaign|content, 소문자)에 포함된 세션을 가진 유저 (user_pseudo_id)
// 지표 1) 10/13~오늘 누적 MAU (UTM 유입 고유 유저)
// 지표 2) 날짜별 × UTM별 고유 유저 (일별)
// 지표 3) 재방문률 = UTM 유입 유저 중, 10/13~오늘 서로 다른 2일 이상 방문(page_view)한 유저 비율
//
// 실행:  GCP_SA_KEY='{...서비스계정 JSON...}' node scripts/fetch.mjs
//        로컬에서는 gcloud auth application-default login 후 GCP_SA_KEY 없이 실행 가능
// 옵션:  DRY_RUN=1  → 쿼리를 실제로 실행하지 않고 문법/스캔량만 검증
//        PRINT_SQL=1 → 생성된 SQL을 출력

import { BigQuery } from '@google-cloud/bigquery';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = 'mimetic-client-454016-b9';
const DATASET = 'analytics_497331424';
const START = '2026-10-13'; // 런칭일
const BQ_LOCATION = process.env.BQ_LOCATION || undefined;

// 매칭 규칙: UTM 4개 필드를 '|'로 이어붙인 문자열에서 부분 일치 (대소문자 무시, 뒤에 붙은 날짜 등 포함)
const KEYWORDS = [
  // 오공고 인스타그램 (instagramjob 은 instagramjob_* 전체를 포함하는 상위 키워드)
  { keyword: 'instagramjob',            grp: '오공고 인스타',     label: '오공고 인스타 · 전체' },
  { keyword: 'instagramjob_littly',     grp: '오공고 인스타',     label: '오공고 인스타 · 리틀리' },
  { keyword: 'instagramjob_story',      grp: '오공고 인스타',     label: '오공고 인스타 · 스토리' },
  { keyword: 'instagramjob_profile',    grp: '오공고 인스타',     label: '오공고 인스타 · 프로필' },
  // 렛츠커리어 인스타그램
  { keyword: 'instagram_profile',       grp: '렛츠커리어 인스타', label: '렛츠커리어 인스타 · 프로필' },
  { keyword: 'instagram_story',         grp: '렛츠커리어 인스타', label: '렛츠커리어 인스타 · 스토리' },
  { keyword: 'instagram_littly',        grp: '렛츠커리어 인스타', label: '렛츠커리어 인스타 · 프로필 리틀리' },
  // 오공고 스레드
  { keyword: 'threadjob_feed',          grp: '오공고 스레드',     label: '오공고 스레드 · 피드' },
  { keyword: 'threadjob_profile',       grp: '오공고 스레드',     label: '오공고 스레드 · 프로필' },
  // 렛츠커리어 스레드
  { keyword: 'thread_feed',             grp: '렛츠커리어 스레드', label: '렛츠커리어 스레드 · 피드' },
  { keyword: 'thread_profile',          grp: '렛츠커리어 스레드', label: '렛츠커리어 스레드 · 프로필' },
  // 카카오톡방
  { keyword: 'kakaotalk_ai',            grp: '카카오톡방',        label: '카톡방 · 오공고 AI' },
  { keyword: 'kakaotalk_pm',            grp: '카카오톡방',        label: '카톡방 · 오공고 기획' },
  { keyword: 'kakaotalk_mkt',           grp: '카카오톡방',        label: '카톡방 · 오공고 마케팅' },
  { keyword: 'kakaotalk_sales',         grp: '카카오톡방',        label: '카톡방 · 오공고 세일즈' },
  { keyword: 'kakaotalk_hr',            grp: '카카오톡방',        label: '카톡방 · 오공고 인사' },
  { keyword: 'kakaotalk_gongchae',      grp: '카카오톡방',        label: '카톡방 · 공채 정보방' },
  // 기타
  { keyword: 'ogongo',                  grp: '기타 키워드',       label: 'ogongo' },
];

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const S = START.replaceAll('-', '');
const TODAY_SFX = `FORMAT_DATE('%Y%m%d', CURRENT_DATE('Asia/Seoul'))`;

// ── 공통 CTE ────────────────────────────────────────────────────────────────
const BASE = `
WITH ev AS (
  SELECT
    PARSE_DATE('%Y%m%d', event_date) AS dt,
    event_name,
    user_pseudo_id,
    CONCAT(
      LOWER(IFNULL(session_traffic_source_last_click.manual_campaign.source, '')),        '|',
      LOWER(IFNULL(session_traffic_source_last_click.manual_campaign.medium, '')),        '|',
      LOWER(IFNULL(session_traffic_source_last_click.manual_campaign.campaign_name, '')), '|',
      LOWER(IFNULL(session_traffic_source_last_click.manual_campaign.content, ''))
    ) AS utm_str
  FROM \`${PROJECT}.${DATASET}.events_*\`
  WHERE (   _TABLE_SUFFIX BETWEEN '${S}' AND ${TODAY_SFX}
         OR _TABLE_SUFFIX BETWEEN 'intraday_${S}' AND CONCAT('intraday_', ${TODAY_SFX}))
    AND user_pseudo_id IS NOT NULL
),

kw AS (
  SELECT * FROM UNNEST([
    ${KEYWORDS.map((k) => `STRUCT('${q(k.keyword)}' AS keyword, '${q(k.grp)}' AS grp, '${q(k.label)}' AS label)`).join(',\n    ')}
  ])
),

ev_utm AS (
  SELECT DISTINCT dt, user_pseudo_id, utm_str
  FROM ev
  WHERE utm_str != '|||'
),

-- UTM 유입 이벤트 × 키워드 (한 유저가 여러 키워드에 걸릴 수 있음)
matched AS (
  SELECT e.dt, e.user_pseudo_id, k.keyword, k.grp, k.label
  FROM ev_utm e
  JOIN kw k ON STRPOS(e.utm_str, k.keyword) > 0
),

-- UTM 유입 유저 (유저당 1행, 처음 UTM으로 들어온 날짜)
utm_users AS (
  SELECT user_pseudo_id, MIN(dt) AS first_dt
  FROM matched
  GROUP BY user_pseudo_id
),

days AS (
  SELECT d AS dt
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE '${START}', CURRENT_DATE('Asia/Seoul'))) AS d
)`;

// 재방문 계산용 추가 CTE: 방문일 = page_view 가 발생한 날짜 (유입 경로와 무관하게 전부 인정)
const REVISIT = `${BASE},

visit_days AS (
  SELECT DISTINCT user_pseudo_id, dt
  FROM ev
  WHERE event_name = 'page_view'
),

user_days AS (
  SELECT
    u.user_pseudo_id,
    u.first_dt,
    COUNT(DISTINCT v.dt) AS n_days,
    ARRAY_AGG(v.dt IGNORE NULLS ORDER BY v.dt)[SAFE_OFFSET(1)] AS second_day
  FROM utm_users u
  LEFT JOIN visit_days v USING (user_pseudo_id)
  GROUP BY u.user_pseudo_id, u.first_dt
)`;

const SQL = {
  // 일별: UTM 유입 DAU, 신규 UTM 유입 유저, 누적 MAU
  daily: `${BASE}
SELECT
  dt,
  IFNULL(dau.users, 0) AS dau,
  IFNULL(nu.users, 0)  AS new_users,
  SUM(IFNULL(nu.users, 0)) OVER (ORDER BY dt) AS cum_mau
FROM days
LEFT JOIN (SELECT dt, COUNT(DISTINCT user_pseudo_id) AS users FROM matched GROUP BY dt) dau USING (dt)
LEFT JOIN (SELECT first_dt AS dt, COUNT(*) AS users FROM utm_users GROUP BY first_dt) nu USING (dt)
ORDER BY dt`,

  // 일별 × 키워드별 고유 유저
  byKeyword: `${BASE}
SELECT dt, keyword, grp, label, COUNT(DISTINCT user_pseudo_id) AS users
FROM matched
GROUP BY dt, keyword, grp, label
ORDER BY dt, grp, keyword`,

  // 일별 × 채널 그룹별 고유 유저 (그룹 안 중복 유저는 1명)
  byGroup: `${BASE}
SELECT dt, grp, COUNT(DISTINCT user_pseudo_id) AS users
FROM matched
GROUP BY dt, grp
ORDER BY dt, grp`,

  // 방문일수 분포 (1일 / 2일 / 3일 / 4일 이상)
  revisitDist: `${REVISIT}
SELECT LEAST(GREATEST(n_days, 1), 4) AS bucket, COUNT(*) AS users
FROM user_days
GROUP BY bucket
ORDER BY bucket`,

  // 날짜 기준(as-of) 재방문률 추이: 그날까지의 UTM 유입 유저 중, 그날까지 2일 이상 방문한 유저
  revisitTrend: `${REVISIT}
SELECT
  d.dt,
  COUNTIF(u.first_dt <= d.dt) AS utm_users,
  COUNTIF(u.second_day IS NOT NULL AND GREATEST(u.first_dt, u.second_day) <= d.dt) AS revisit_users
FROM days d
CROSS JOIN user_days u
GROUP BY d.dt
ORDER BY d.dt`,
};

// ── 실행 ────────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../docs/data/kpi.json');

if (process.env.PRINT_SQL) {
  for (const [name, sql] of Object.entries(SQL)) console.log(`\n-- ===== ${name} =====\n${sql}\n`);
}

const clientOpts = { projectId: PROJECT };
if (process.env.GCP_SA_KEY) clientOpts.credentials = JSON.parse(process.env.GCP_SA_KEY);
const bq = new BigQuery(clientOpts);

// DATE 컬럼은 {value:'YYYY-MM-DD'} 로 오므로 문자열로 펴준다
const ymd = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const num = (v) => (v == null ? 0 : Number(v));

async function run(name) {
  const [job] = await bq.createQueryJob({ query: SQL[name], location: BQ_LOCATION, dryRun: !!process.env.DRY_RUN });
  if (process.env.DRY_RUN) {
    const bytes = Number(job.metadata.statistics.totalBytesProcessed);
    console.log(`[dry-run] ${name}: OK, ${(bytes / 1e6).toFixed(1)} MB 스캔 예정`);
    return [];
  }
  const [rows] = await job.getQueryResults();
  console.log(`[ok] ${name}: ${rows.length} rows`);
  return rows;
}

const [daily, byKeyword, byGroup, dist, trend] = await Promise.all(
  ['daily', 'byKeyword', 'byGroup', 'revisitDist', 'revisitTrend'].map(run),
);

if (process.env.DRY_RUN) process.exit(0);

const utmUsers = dist.reduce((a, r) => a + num(r.users), 0);
const revisitUsers = dist.filter((r) => num(r.bucket) >= 2).reduce((a, r) => a + num(r.users), 0);
const last = daily[daily.length - 1];

const out = {
  generated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00',
  period: { start: START, end: ymd(last?.dt) ?? START },
  definitions: {
    population: 'UTM(source|medium|campaign|content)에 지정 키워드가 포함된 세션으로 한 번이라도 방문한 유저(user_pseudo_id)',
    mau: `${START}~오늘 UTM 유입 고유 유저 누적`,
    daily_utm: '해당 날짜에 해당 UTM으로 방문한 고유 유저',
    revisit: `UTM 유입 유저 중 ${START}~오늘 서로 다른 2일 이상 page_view가 발생한 유저 비율 (유입 경로 무관)`,
  },
  keywords: KEYWORDS,
  summary: {
    mau_cum: num(last?.cum_mau),
    today_dau: num(last?.dau),
    utm_users: utmUsers,
    revisit_users: revisitUsers,
    revisit_rate: utmUsers ? revisitUsers / utmUsers : null,
  },
  daily: daily.map((r) => ({ dt: ymd(r.dt), dau: num(r.dau), new_users: num(r.new_users), cum_mau: num(r.cum_mau) })),
  by_group: byGroup.map((r) => ({ dt: ymd(r.dt), grp: r.grp, users: num(r.users) })),
  by_keyword: byKeyword.map((r) => ({ dt: ymd(r.dt), keyword: r.keyword, grp: r.grp, label: r.label, users: num(r.users) })),
  revisit: {
    distribution: dist.map((r) => ({ days: num(r.bucket), users: num(r.users) })),
    trend: trend.map((r) => ({
      dt: ymd(r.dt),
      utm_users: num(r.utm_users),
      revisit_users: num(r.revisit_users),
      rate: num(r.utm_users) ? num(r.revisit_users) / num(r.utm_users) : null,
    })),
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}`);
