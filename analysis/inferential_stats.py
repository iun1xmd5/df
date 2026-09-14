"""Welch's t-test with Cohen's d and Holm-Bonferroni correction.

Reproduces Table 2 of the paper. The six pairwise tests on Register-1000
are the family over which FWER is controlled.

Usage:
    python inferential_stats.py --input ../results --output ../figures
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

PAIRS = [(5, 10), (10, 15), (5, 15)]
PEERS = [5, 10, 15]


def welch_and_cohens_d(x, y):
    """Return Welch t, p, and Cohen's d (pooled SD)."""
    t, p = stats.ttest_ind(x, y, equal_var=False)
    nx, ny = len(x), len(y)
    sx, sy = x.std(ddof=1), y.std(ddof=1)
    sp = np.sqrt(((nx - 1) * sx ** 2 + (ny - 1) * sy ** 2) / (nx + ny - 2))
    d = (x.mean() - y.mean()) / sp if sp > 0 else np.nan
    return t, p, d


def holm_bonferroni(p_values, alpha=0.05):
    """Return Holm-adjusted p-values (monotonicity enforced)."""
    m = len(p_values)
    order = np.argsort(p_values)
    adjusted = np.empty(m)
    running_max = 0.0
    for rank, idx in enumerate(order):
        adj = (m - rank) * p_values[idx]
        running_max = max(running_max, adj)
        adjusted[idx] = min(running_max, 1.0)
    return adjusted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, type=Path)
    ap.add_argument('--output', required=True, type=Path)
    args = ap.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    latency = {}
    throughput = {}
    for n in PEERS:
        lat_csv = sorted((args.input / f'{n}peers' / 'report').glob('txs_reg-1000_*.csv'))
        if not lat_csv:
            raise FileNotFoundError(f'No reg-1000 CSVs for {n} peers')
        frames = []
        for f in lat_csv:
            df = pd.read_csv(f)
            df.columns = [c.lower() for c in df.columns]
            frames.append(df[['latency']])
        all_lat = pd.concat(frames, ignore_index=True)
        latency[n] = all_lat['latency'].to_numpy(dtype=float)
        throughput[n] = 1000.0 / all_lat.groupby('worker').size().mean()  # placeholder

    rows = []
    raw_p = []
    for a, b in PAIRS:
        t, p, d = welch_and_cohens_d(latency[a], latency[b])
        rows.append({'metric': 'latency', 'a': a, 'b': b,
                     'delta': latency[a].mean() - latency[b].mean(),
                     't': t, 'p': p, 'd': d})
        raw_p.append(p)
    for a, b in PAIRS:
        t, p, d = welch_and_cohens_d(
            np.array([throughput[a]]), np.array([throughput[b]]))
        rows.append({'metric': 'throughput', 'a': a, 'b': b,
                     'delta': throughput[a] - throughput[b],
                     't': t, 'p': p, 'd': d})
        raw_p.append(p)

    adjusted = holm_bonferroni(np.array(raw_p), alpha=0.05)
    for row, adj in zip(rows, adjusted):
        row['p_holm'] = adj

    out = pd.DataFrame(rows)
    out.to_csv(args.output / 'inferential_stats.csv', index=False)
    print(out.to_string(index=False))


if __name__ == '__main__':
    main()
