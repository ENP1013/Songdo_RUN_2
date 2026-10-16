// .env 파일을 읽어 process.env에 채움 (의존성 없는 간단 버전: KEY=VALUE 줄만, # 주석 무시)
// 이미 설정된 환경변수는 덮어쓰지 않고, .env.example의 자리표시자 값("여기에")은 건너뜀. 로컬 개발 서버 전용 (Vercel은 대시보드 환경변수 사용)
const fs = require("fs");

module.exports = function loadEnv(file) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const loaded = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!value || value.includes("여기에") || m[1] in process.env) continue;
    process.env[m[1]] = value; loaded.push(m[1]);
  }
  return loaded;   // 읽어 온 변수 이름만 반환(값은 로그에 남기지 않음)
};
