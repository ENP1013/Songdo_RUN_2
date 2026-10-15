# Run & Walk 코스 메이커 (송도)

인천 연수구 송도동에서 출발지·도착지와 페이스, 취향을 고르면 실제 보행로를 따라 20 · 40 · 60분 코스를 지도에 빨간 경로로 그리고, 예상 거리·칼로리·운동 팁을 보여주는 웹앱입니다. (26-3차 바이브코딩 경진대회 Scenario 7)

- 코스 계산은 서버 없이 브라우저에서 합니다.
- Vercel 배포에서는 닉네임·비밀번호 로그인과 운동 기록 저장(Upstash Redis)을 씁니다. 백엔드가 없는 곳(GitHub Pages 등)에서는 로그인 버튼이 숨겨지고 기록은 브라우저에만 저장됩니다.

## 구성

| 파일 | 역할 |
|---|---|
| `src/app.html` | 화면 (입력, 코스 카드, 지도, 기록·배지) |
| `src/engine.js` | 코스 생성 엔진: OSM 보행 그래프 위 A* 탐색, 원형·공원 둘레·왕복·우회·언덕 반복 후보 생성, 공원 구간 비율 계산 |
| `tools/fetch_osm.py` | Overpass API로 송도 OSM 원본 받기 → `data/osm_raw.json` |
| `tools/build_data.py` | 원본을 압축한 지도·보행망 데이터 → `data/songdo.json` |
| `api/` | Vercel 서버 함수: `auth/signup`, `auth/login`, `auth/logout`, `me`, `workouts` (`_lib.js` 공용) |
| `tests/api.test.js` | 메모리 저장소로 API 동작 테스트 (`node --test tests/api.test.js`) |
| `tools/dev_server.js` | 로컬 확인용 서버 (`PORT=3917 node tools/dev_server.js`, 메모리 저장소) |
| `tools/build.py` | 단일 HTML 생성 → `index.html`(claude.ai 아티팩트용), `docs/index.html`(GitHub Pages용) |

지도는 Leaflet 1.9.4와 OpenStreetMap 타일을 씁니다. 타일을 불러올 수 없는 환경에서는 `songdo.json`의 도로·공원·물 데이터로 지도를 직접 그립니다.

## 빌드

```bash
python tools/fetch_osm.py      # (데이터를 새로 받을 때만)
python tools/build_data.py     # (데이터를 새로 받을 때만)
python tools/build.py
```

## 백엔드 (Vercel)

- `vercel.json`이 `docs/`를 정적 사이트로, `api/`를 서버 함수로 배포합니다. npm 패키지가 필요 없습니다.
- 저장소: Vercel 프로젝트 → Storage → Upstash for Redis 연결. `KV_REST_API_URL`·`KV_REST_API_TOKEN`(또는 `UPSTASH_REDIS_REST_*`) 환경변수가 자동 등록됩니다.
- 선택: `SESSION_SECRET` 환경변수(긴 임의 문자열). 없으면 Redis 토큰에서 파생합니다.
- 보안: 비밀번호 scrypt 해시, 서명된 httpOnly·Secure·SameSite=Lax 쿠키(30일), 같은 닉네임 5회 실패 시 5분 잠금, IP별 가입·로그인 요청 제한, 쓰기 요청은 JSON만 허용, 기록은 세션의 사용자 것만 읽고 씀.

## 계산 규칙

- 거리 = 속도(km/h) × 시간(h), 칼로리 = MET × 체중(kg) × 시간(h)
- 코드가 숫자를 계산하고, LLM(claude.ai에서 열 때만)은 코스 설명·팁 문장만 씁니다.

## 데이터 출처

지도·보행로·공원 데이터 © OpenStreetMap 기여자 (ODbL). OSM 공용 타일 서버는 트래픽이 많으면 제한될 수 있어 실서비스에서는 다른 타일 제공자로 바꾸는 것이 좋습니다.
