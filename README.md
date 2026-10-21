# 오늘의공고 웹사이트 KPI 대시보드

UTM 유입 유저 기준으로 아래 3가지를 보여줍니다. (런칭일 2026-10-13부터)

1. 누적 MAU (10/13 ~ 오늘, UTM 유입 고유 유저)
2. 날짜별 × UTM별 방문 유저 (일별 고유 유저, 채널 그룹/키워드 보기)
3. 재방문률 (UTM 유입 유저 중 서로 다른 2일 이상 방문한 비율) + 추이 + 방문일수 분포

```
docs/index.html            대시보드 화면 (docs/data/kpi.json 을 읽어서 그림)
scripts/fetch.mjs          BigQuery 쿼리 5개 실행 → docs/data/kpi.json 생성
.github/workflows/update-kpi.yml   매일 08:00, 18:00 KST 자동 실행 + 수동 실행
```

## 처음 한 번만 설정

1. 이 폴더를 GitHub repo에 올립니다.
2. BigQuery 읽기용 서비스 계정을 만들고 키(JSON)를 받습니다.
   - 프로젝트 `mimetic-client-454016-b9` 에서 `BigQuery 데이터 뷰어` + `BigQuery 작업 사용자` 역할
3. repo → Settings → Secrets and variables → Actions → `GCP_SA_KEY` 에 키 JSON 전체를 붙여넣습니다.
4. repo → Settings → Pages → Branch `main`, 폴더 `/docs` 로 설정합니다.
5. Actions 탭 → `Update KPI data` → Run workflow 로 한 번 실행하면 `docs/data/kpi.json` 이 생기고 화면에 숫자가 나옵니다.

## 바꾸고 싶을 때

- UTM 키워드 추가/삭제: `scripts/fetch.mjs` 맨 위 `KEYWORDS` 배열을 고칩니다. UTM의 source·medium·campaign·content를 합친 문자열에서 **부분 일치(대소문자 무시)** 로 찾습니다.
- 갱신 시간: `.github/workflows/update-kpi.yml` 의 `cron` (UTC 기준)
- 마케팅 어드민에 넣기: Pages 주소를 iframe으로 넣으면 됩니다. 다크 모드로 고정하려면 주소 뒤에 `?theme=dark`

## 로컬에서 확인

```
npm install
GCP_SA_KEY='{...}' DRY_RUN=1 node scripts/fetch.mjs   # 쿼리 문법·스캔량만 확인
GCP_SA_KEY='{...}' node scripts/fetch.mjs             # kpi.json 생성
cd docs && python3 -m http.server 8000                # http://localhost:8000
```

## 지표 정의

- 모수: UTM에 지정 키워드가 포함된 세션으로 한 번이라도 방문한 유저 (`user_pseudo_id`, 기기·브라우저 단위)
- 방문일: `page_view` 가 발생한 날짜. 재방문은 유입 경로와 무관하게 인정합니다. (처음엔 UTM, 두 번째는 직접 접속이어도 재방문)
- 키워드 `instagramjob` 은 `instagramjob_*` 를 모두 포함해서 세부 행과 겹칩니다. 전체/그룹 값은 유저 중복을 제거합니다.
