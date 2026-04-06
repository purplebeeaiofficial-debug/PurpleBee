# Purple Bee Cloudflare Deployment

이 폴더는 Cloudflare에서 Purple Bee 웹사이트를 정적으로 배포하기 위한 배포본입니다.

## 현재 구조

- 정적 웹 UI는 현재 `D:\Purple Bee AI\app\templates\index.html`을 `cloudflare/public/index.html`로 동기화해 서비스합니다.
- `workers/weight-server.js`는 `/api/health`와 정적 자산 서빙을 처리합니다.
- 브라우저 채팅은 클라이언트 로컬 로직으로 동작합니다.
- 대화 기록은 브라우저 localStorage에 저장되므로, 여러 사용자가 같은 사이트에 접속해도 각자 독립적으로 사용할 수 있습니다.

## 중요한 점

기존 `app/app.py` Flask 서버는 로컬/데스크톱용이며, 모델 패널도 로컬에서만 사용합니다. Cloudflare 배포본은 공개용 웹 UI와 정적 자산만 담당합니다.

## 배포 준비

1. Cloudflare Dashboard에서 `Account ID`와 `API Token`을 준비합니다.
2. API Token은 Cloudflare 공식 문서 기준으로 Workers 배포 권한이 있는 토큰을 사용합니다.
3. `setup_token.bat` 또는 `Cloudflare_토큰설정.bat`를 실행해 `cf-auth.local.json`을 생성합니다.
5. Development: `dev_cloudflare.bat`
6. Deploy: `deploy_cloudflare.bat`

## 로컬 개발

1. `D:\Purple Bee AI\cloudflare`로 이동합니다.
2. `dev_cloudflare.bat` 또는 `wrangler dev --remote`를 실행합니다.
3. 브라우저에서 Wrangler가 알려주는 주소로 접속합니다.
4. `/api/health`가 `mode: "browser-local"`을 반환하면 정적 배포 구조가 정상입니다.

## 실제 배포

1. `D:\Purple Bee AI\cloudflare`에서 `deploy_cloudflare.bat` 또는 `wrangler deploy`를 실행합니다.
2. 배포가 끝나면 `https://<worker-name>.<subdomain>.workers.dev` 주소가 생성됩니다.
3. 그 주소로 접속하면 다른 사용자도 같은 사이트에서 AI를 바로 사용할 수 있습니다.

## 다음 확장

1. 대화 기록을 계정별로 저장하려면 D1을 추가합니다.
2. 문서 업로드나 파일 저장이 필요하면 R2를 추가합니다.
3. 사용량 제어가 필요하면 Turnstile, Rate Limiting, Durable Objects를 붙입니다.
