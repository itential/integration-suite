'use strict';

/**
 * Small dependency-free line-level diff (classic LCS backtrace). Good enough
 * for spotting "a shared partial changed and now this page's rendered
 * output differs" - not meant to compete with a real diff library for huge
 * inputs, but rendered config/template output is small enough that O(n*m)
 * LCS is fine.
 */
function lineDiff(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const n = a.length;
  const m = b.length;

  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'equal', value: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: 'remove', value: a[i] });
      i += 1;
    } else {
      result.push({ type: 'add', value: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', value: a[i] });
    i += 1;
  }
  while (j < m) {
    result.push({ type: 'add', value: b[j] });
    j += 1;
  }
  return result;
}

module.exports = { lineDiff };
