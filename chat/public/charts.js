// Simple canvas bar chart for daily usage
function renderDailyChart(canvas, data) {
  if (!data || !data.length) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const pad = { top: 20, right: 10, bottom: 40, left: 50 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  // Find max
  const maxVal = Math.max(...data.map(d => (d.total_input || 0) + (d.total_output || 0)), 1);
  const barW = Math.max(4, (cw / data.length) - 2);

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#71717a'; ctx.font = '10px Inter';
    ctx.textAlign = 'right';
    ctx.fillText(formatK(maxVal - (maxVal / 4) * i), pad.left - 6, y + 4);
  }

  // Bars
  data.forEach((d, i) => {
    const x = pad.left + (cw / data.length) * i + 1;
    const input = d.total_input || 0;
    const output = d.total_output || 0;
    const total = input + output;
    const h = (total / maxVal) * ch;
    const inputH = (input / maxVal) * ch;
    const outputH = (output / maxVal) * ch;

    // Input bar
    ctx.fillStyle = '#8b5cf6';
    ctx.fillRect(x, pad.top + ch - h, barW, inputH);
    // Output bar on top
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x, pad.top + ch - outputH, barW, outputH);

    // Date label (every few)
    if (data.length <= 15 || i % Math.ceil(data.length / 10) === 0) {
      ctx.save();
      ctx.fillStyle = '#71717a'; ctx.font = '9px Inter';
      ctx.textAlign = 'center';
      const dateStr = new Date(d.date).toLocaleDateString('en', { month: 'short', day: 'numeric' });
      ctx.fillText(dateStr, x + barW / 2, H - pad.bottom + 14);
      ctx.restore();
    }
  });

  // Legend
  ctx.fillStyle = '#8b5cf6'; ctx.fillRect(W - 120, 6, 10, 10);
  ctx.fillStyle = '#e4e4e7'; ctx.font = '10px Inter'; ctx.textAlign = 'left';
  ctx.fillText('Input', W - 106, 15);
  ctx.fillStyle = '#3b82f6'; ctx.fillRect(W - 60, 6, 10, 10);
  ctx.fillStyle = '#e4e4e7'; ctx.fillText('Output', W - 46, 15);
}

function formatK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toString();
}
