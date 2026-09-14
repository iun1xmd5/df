"""BCa bootstrap confidence intervals on pairwise throughput differences.

Reproduces the robustness check described in the paper's Reliability
Analysis subsection.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

N_BOOT = 10_000
ALPHA = 0.05
PAIRS = [(5, 10), (10, 15), (5, 15)]


def bca_ci(x, y, n_boot=N_BOOT, alpha=ALPHA, rng=None):
    rng = rng or np.random.default_rng(42)
    obs = x.mean() - y.mean()
    pooled = np.concatenate([x, y])
    boot = np.array([
        rng.choice(pooled, len(x), replace=True).mean()
        - rng.choice(pooled, len(y), replace=True).mean()
        for _ in range(n_boot)
    ])
    z0 = norm.ppf((boot < obs).mean() or 1e-6)
    jx = np.array([np.delete(x, i).mean() for i in range(len(x))])
    jy = np.array([np.delete(y, i).mean() for i in range(len(y))])
    jd = jx.mean() - jy.mean() - (jx - jx.mean()) + (jy - jy.mean())
    num = ((jd.mean() - jd) ** 3).sum()
    den = 6 * (((jd.mean() - jd) ** 2).sum() ** 1.5)
    a = num / den if den else 0.0
    z_lo, z_hi = norm.ppf(alpha / 2), norm.ppf(1 - alpha / 2)
    p_lo = norm.cdf(z0 + (z0 + z_lo) / (1 - a * (z0 + z_lo)))
    p_hi = norm.cdf(z0 + (z0 + z_hi) / (1 - a * (z0 + z_hi)))
    return obs, np.quantile(boot, [p_lo, p_hi])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, type=Path)
    args = ap.parse_args()

    throughput = {}
    for n in (5, 10, 15):
        csv = sorted((args.input / f'{n}peers' / 'report').glob('txs_reg-1000_*.csv'))
        if not csv:
            raise FileNotFoundError(f'No reg-1000 CSVs for {n} peers')
        frames = [pd.read_csv(f) for f in csv]
        for f in frames:
            f.columns = [c.lower() for c in f.columns]
        lat = pd.concat(frames, ignore_index=True)['latency'].to_numpy(dtype=float)
        throughput[n] = 1000.0 / lat.sum()

    print('BCa 95% CIs on throughput differences:')
    for a, b in PAIRS:
        obs, ci = bca_ci(np.array([throughput[a]]), np.array([throughput[b]]))
        print(f'  {a} vs {b}: Δ = {obs:+.3f} TPS [95% BCa {ci[0]:+.3f}, {ci[1]:+.3f}]')


if __name__ == '__main__':
    main()
