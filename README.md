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
| `tools/guide/` | 사용 가이드 영상(`docs/guide.mp4`) 자동 녹화·합성. 아래 "사용 가이드 영상" 참고 |

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
- AI 운동 팁(GPT): Vercel 환경변수에 `OPENAI_API_KEY`를 등록하면 코스 상세의 **AI 코스 설명 받기**가 로그인한 사용자에게 GPT가 쓴 코스 설명·팁 3개·동기부여 문구를 보여줍니다. 모델은 `OPENAI_MODEL`(기본 `gpt-5.6-luna`, OpenAI 대시보드 모델 목록의 ID와 같아야 함)로 바꿀 수 있고, 키는 서버(`api/tips.js`)에서만 쓰며 저장소에 넣지 않습니다. 로컬에서는 `.env.example`을 `.env`로 복사해 값을 채우면 `node tools/dev_server.js`가 읽습니다(`.env`는 git에 올라가지 않음). 키가 없으면 기본 팁만 보입니다. 사용자당 10분 10회·하루 60회로 제한하고, 같은 조건은 하루 동안 캐시합니다.
- 보안: 비밀번호 scrypt 해시, 서명된 httpOnly·Secure·SameSite=Lax 쿠키(30일), 같은 닉네임 5회 실패 시 5분 잠금, IP별 가입·로그인 요청 제한, 쓰기 요청은 JSON만 허용, 기록은 세션의 사용자 것만 읽고 씀.

## 계산 규칙

- 거리 = 속도(km/h) × 시간(h), 칼로리 = MET × 체중(kg) × 시간(h)
- 코드가 숫자를 계산하고, LLM(claude.ai에서 열 때만)은 코스 설명·팁 문장만 씁니다.
- 내 페이스 직접 입력은 km/h(3~25)로 받습니다.
- 인터벌: 워밍업(3분, 40분 이상은 5분) → (고강도 2분 = 기본 속도 +2 km/h, 저강도 1분 = −2 km/h) × n세트 → 남는 시간은 쿨다운. 목표 거리와 칼로리는 구간별 속도로 더하고, 지도에는 계획 속도대로 달린다고 보고 경로를 구간별 색으로 나눕니다. 걷기(6.5 km/h 미만)에서는 인터벌을 끕니다.
- 송도 안은 평지로 봅니다. Copernicus DEM(90 m)으로 송도동 보행로 182곳을 확인하니 중앙값 7 m, 범위 0~17 m였습니다. 오르막 코스는 송도동 밖 봉재산(약 100 m)을 씁니다.

## 실시간 기록 (GPS)

코스 상세의 **운동 시작 (GPS 기록)** 을 누르면 `watchPosition`으로 위치를 받아 실제 이동 거리를 더합니다. 코스를 벗어나도 실제로 움직인 거리로 기록됩니다.

- 정확도 35 m보다 나쁜 위치는 버리고, max(5 m, 정확도의 절반)보다 작은 움직임은 흔들림으로 보고 무시합니다. 초속 8 m를 넘는 순간이동도 버리는데, 3번 연속으로 들어오면 그 위치를 새 기준으로 삼습니다(이때 거리는 더하지 않음).
- 시계는 첫 번째로 정확한 위치를 받을 때 시작합니다. 일시정지한 동안의 시간과 거리는 빼고, 코스에서 40 m 넘게 벗어나면 알려 줍니다.
- 칼로리는 실제 평균 속도로 MET를 다시 계산합니다.
- 운동하는 동안 Wake Lock으로 화면이 꺼지지 않게 합니다. 웹은 백그라운드에서 GPS를 받을 수 없어서, 화면이 꺼져 있던 구간은 끊긴 두 지점을 직선으로 잇습니다.
- 진행 상태를 localStorage에 저장하므로 새로고침하거나 탭이 닫혀도 6시간 안에 다시 열면 이어서 기록합니다.
- 화면 흐름: 3·2·1 카운트다운 → 전체 화면 러닝 모드(큰 거리 숫자, 기록/지도 전환) → 일시정지 → 길게 눌러 종료(키보드는 두 번 눌러 종료) → km 구간 기록이 담긴 요약. 1 km마다 음성으로 거리와 평균 페이스를 알려 주고(Web Speech API, 끌 수 있음), 진행 방향은 화살표로 표시합니다.

## 사용 가이드 영상

상단의 **사용 가이드 영상** 버튼은 `docs/guide.mp4`(모바일 화면, 약 1분 44초)를 재생합니다. 화면이 바뀌면 다시 만들 수 있습니다.

```bash
PORT=3918 node tools/dev_server.js &                 # 메모리 저장소 (데모 사용자·기록은 스크립트가 넣음)
node tools/guide/record.js <작업 폴더> 3918           # 헤드리스 Chrome 390x844로 가입→코스→GPS 기록→공유→커뮤니티→랭킹 녹화
python tools/guide/compose.py <작업 폴더>/v docs/guide.mp4   # 자막·인트로·엔딩 합성 (pip install imageio-ffmpeg pillow)
```

GPS 장면은 코스 경로를 따라 가짜 위치를 넣고 시계를 30배 빠르게 돌려 녹화합니다(자막에 표시).

## 데이터 출처

지도·보행로·공원 데이터 © OpenStreetMap 기여자 (ODbL). OSM 공용 타일 서버는 트래픽이 많으면 제한될 수 있어 실서비스에서는 다른 타일 제공자로 바꾸는 것이 좋습니다.
