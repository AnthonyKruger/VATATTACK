// Game values
window.GameValues = {
  limits: {
    maxObjects: 50,
  },
  colors: {
    accentStart: '#3cb3d8',
    accentEnd: '#9a36fe',
  },
  player: {
    baseSpeed: 4.5,
    invulMs: 3000,
    invulMinMs: 500,
    invulFlickerMs: 100,
  },
  spawn: {
    baseInterval: 1300,
    minInterval: 100,
    fallSpeedMin: 1.5,
    fallSpeedRange: 2.0,
    zigzagBase: 0.05,
    zigzagPerLevel: 0.01,
    zigzagCap: 0.5,
  },
  spawnArea: {
    width: 460, // canvas.width - object.w
  },
  difficulty: {
    stepPerLevel: 0.10, // +10% per level
    pointsPerLevel: 2000,
  },
  flash: {
    durationMs: 200,
    maxAlpha: 0.5,
  },
  bonus: {
    durationMs: 3000,
    flickerMs: 150,
    text: 'BONUS!',
    font: "48px 'Ka', sans-serif",
  },
  final: {
    countMs: 3000,
  },
  hud: {
    scoreAnimMs: 1000,
    font: "32px 'boldpixels', sans-serif",
  },
  probabilities: {
    fuel: 0.10,
    vatit: 0.05,
    auditBase: 0.10,
    fraudBase: 0.10,
    auditFraudScalePerLevel: 0.05, // +5% per level (relative)
    auditFraudCap: 0.50,
    invoiceMin: 0.05,
  },
};
