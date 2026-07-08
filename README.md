# Pulse

시장의 맥박을 짚는 개인 뉴스 기록 대시보드.

## 로컬 실행

```
npm install
npm run dev
```

## 빌드

```
npm run build
```

`dist/` 폴더에 정적 파일이 생성됩니다. Cloudflare Pages는 이 명령을 자동으로 실행합니다.

## 데이터 저장

브라우저의 localStorage에 저장됩니다 (기기별로 별도 저장, 서버 전송 없음).
같은 기기의 같은 브라우저에서만 데이터가 유지되니, 다른 기기에서도 쓰고 싶다면
추후 별도 동기화(Cloudflare KV 등)를 붙이는 걸 고려해보세요.
