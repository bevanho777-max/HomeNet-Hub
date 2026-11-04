// idle_spin.js (v2.38) — "空闲轮询 / Idle spin": a multi-GPU Strata node whose GPUs read busy
// while it serves nothing.
//
// Strata splits a model across two cards (layer split) and hands work from one card to the
// other through a flag in host memory. On HIP it waits for that flag with a one-thread kernel
// that spins on the GPU (src/split/src/hip/cuda.h, fnx_memop_wait). While such a wave is
// resident the SMU counts the graphics engine as busy, so gpu_busy_percent reads 100 with the
// shader clock at its top bin -- but nothing is computed: the memory clock stays at its idle
// bin and the CPU is idle. m25 2026-11-04 (BACKLOG 47): 100 % / ~230 W with no request at all,
// from the moment the model loaded.
//
// The card face should not call that a red 100 %. When ALL of these hold, the machine card's
// GPU ring is grey and says 空闲轮询 / Idle spin, with the real figures in its title:
//   - the machine's inference node (same id in the inference_nodes target) runs Strata, as the
//     engine detector found it (engine.js) -- llama.cpp nodes are never touched;
//   - the live reader (live.js) reached it within LIVE_MAX_AGE_MS and it reports nothing
//     running and nothing queued, and its last request finished at least QUIET_MS ago (the
//     agent averages a 2 s period: the tail of a request must not read as spin);
//   - the push carries at least two cards (one card has no hand-off; single-card machines and
//     the NVIDIA laptops are never touched);
//   - the average GPU busy is >= BUSY_MIN;
//   - every card's memory is idle: memory clock below MCLK_MAX_MHZ (the two lowest DPM bins
//     of an RX 7900 XTX are 96 and 456 MHz; working cards sit at 1249). Only when the agent
//     sends no clock is mem_busy_pct <= MEM_BUSY_MAX used instead -- it is the weaker signal:
//     measured on m25 it also reads 0-1 % on most samples while a request decodes.
//     An agent that sends neither (older than v2.38, the Windows agent) is never judged.
//
// What changes then: metrics.gpu keeps its real value (the timeseries records it as before),
// its level becomes 'cool' (grey -- no red), and it gains `idle_spin` with the figures for the
// title; the per-card gpuN levels go grey too. A separate `idle_spin` series (1 / 0) is written
// for every machine this applies to, so the machine modal can shade those stretches on the GPU
// chart. A machine the rule does not apply to gets no idle_spin metric at all.

export const BUSY_MIN = 90;
export const MCLK_MAX_MHZ = 500;
export const MEM_BUSY_MAX = 5;
export const QUIET_MS = 10000;
export const LIVE_MAX_AGE_MS = 10000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Apply the rule to one machine's freshly normalized metrics (in place).
 * @param raw      the push body (gpus[] with util_pct / mclk_mhz / mem_busy_pct / power_w)
 * @param target   the machine target (its id names the inference node)
 * @param metrics  normalize()'s metrics for this push
 * @param liveView the last inference_live view ({ nodes: { <id>: { kind, reachable, running, queued, last, at } } })
 * @returns {boolean|null} true / false when judged, null when the rule does not apply
 */
export function applyIdleSpin(raw, target, metrics, liveView, now = Date.now()) {
  const node = liveView?.nodes?.[target?.id];
  if (!node || node.kind !== 'strata') return null;
  const cards = (Array.isArray(raw?.gpus) ? raw.gpus : [])
    .filter((g) => g && typeof g === 'object')
    .map((g, pos) => ({ i: num(g.idx) ?? pos, util: num(g.util_pct), mclk: num(g.mclk_mhz), mem: num(g.mem_busy_pct), power: num(g.power_w) }))
    .sort((a, b) => a.i - b.i);
  if (cards.length < 2) return null;
  if (!cards.every((c) => c.mclk != null || c.mem != null)) return null;
  const g = metrics?.gpu;
  if (!g || num(g.value) == null) return null;

  const fresh = node.reachable === true && num(node.at) != null && now - node.at <= LIVE_MAX_AGE_MS;
  const idle = fresh && !node.running && !node.queued;
  const quiet = now - (num(node.last?.at) || 0) >= QUIET_MS;
  const memIdle = cards.every((c) => (c.mclk != null ? c.mclk < MCLK_MAX_MHZ : c.mem <= MEM_BUSY_MAX));
  const active = idle && quiet && g.value >= BUSY_MIN && memIdle;

  metrics.idle_spin = { value: active ? 1 : 0, level: null, display: active ? '1' : '0' };
  if (!active) return false;
  metrics.gpu = {
    ...g,
    level: 'cool',
    idle_spin: {
      busy: Math.round(g.value),
      cards: cards.map((c) => ({ i: c.i, busy: c.util, mclk: c.mclk, mem: c.mem })),
      power: num(metrics.gpu_power?.value),
    },
  };
  for (const c of cards) {
    const k = `gpu${c.i}`;
    if (metrics[k]) metrics[k] = { ...metrics[k], level: 'cool' };
  }
  return true;
}

