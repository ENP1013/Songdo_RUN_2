# Run & Walk 코스 메이커 (송도)

인천 연수구 송도동에서 출발지·도착지와 페이스, 취향을 고르면 실제 보행로를 따라 20 · 40 · 60분 코스를 지도에 빨간 경로로 그리고, 예상 거리·칼로리·운동 팁을 보여주는 웹앱입니다. (26-3차 바이브코딩 경진대회 Scenario 7)

- 로그인 없음. 입력값과 운동 기록은 각자의 브라우저(localStorage)에만 저장됩니다.
- 서버 없이 정적 파일 하나로 동작합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `src/app.html` | 화면 (입력, 코스 카드, 지도, 기록·배지) |
| `src/engine.js` | 코스 생성 엔진: OSM 보행 그래프 위 A* 탐색, 원형·공원 둘레·왕복·우회·언덕 반복 후보 생성, 공원 구간 비율 계산 |
| `tools/fetch_osm.py` | Overpass API로 송도 OSM 원본 받기 → `data/osm_raw.json` |
| `tools/build_data.py` | 원본을 압축한 지도·보행망 데이터 → `data/songdo.json` |
| `tools/build.py` | 단일 HTML 생성 → `index.html`(claude.ai 아티팩트용), `docs/index.html`(GitHub Pages용) |

지도는 Leaflet 1.9.4와 OpenStreetMap 타일을 씁니다. 타일을 불러올 수 없는 환경에서는 `songdo.json`의 도로·공원·물 데이터로 지도를 직접 그립니다.

## 빌드

```bash
python tools/fetch_osm.py      # (데이터를 새로 받을 때만)
python tools/build_data.py     # (데이터를 새로 받을 때만)
python tools/build.py
```

## 계산 규칙

- 거리 = 속도(km/h) × 시간(h), 칼로리 = MET × 체중(kg) × 시간(h)
- 코드가 숫자를 계산하고, LLM(claude.ai에서 열 때만)은 코스 설명·팁 문장만 씁니다.

## 데이터 출처

지도·보행로·공원 데이터 © OpenStreetMap 기여자 (ODbL). OSM 공용 타일 서버는 트래픽이 많으면 제한될 수 있어 실서비스에서는 다른 타일 제공자로 바꾸는 것이 좋습니다.
