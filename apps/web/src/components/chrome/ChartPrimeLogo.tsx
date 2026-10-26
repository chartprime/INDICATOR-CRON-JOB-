function waveHump(xa: number, xb: number, baseline: number, extremumY: number): string {
  const q = (xb - xa) / 4;
  const mid = (xa + xb) / 2;
  return `C${xa + q},${baseline} ${xa + q},${extremumY} ${mid},${extremumY} C${xb - q},${extremumY} ${xb - q},${baseline} ${xb},${baseline}`;
}

const BASELINE = 22;
const WAVE_PATH = [
  `M2,${BASELINE}`,
  waveHump(2, 24, BASELINE, 31),
  waveHump(24, 50, BASELINE, 4),
  waveHump(50, 70, BASELINE, 30),
  waveHump(70, 96, BASELINE, 10),
].join(" ");

export function ChartPrimeLogo() {
  return (
    <span className="cp-logo">
      <svg className="cp-logo-mark" viewBox="0 0 100 44" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="cp-wave" x1="0" y1="0" x2="100" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#5b4bda" />
            <stop offset="30%" stopColor="#8b5cf6" />
            <stop offset="52%" stopColor="#6d5ce8" />
            <stop offset="68%" stopColor="#f2c94c" />
            <stop offset="100%" stopColor="#f2994a" />
          </linearGradient>
        </defs>
        <path d={WAVE_PATH} stroke="url(#cp-wave)" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="cp-logo-word">
        <span className="cp-logo-word-light">CHART</span>
        <span className="cp-logo-word-strong">PRIME</span>
      </span>
    </span>
  );
}
