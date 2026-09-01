function unpackJs(code) {
  if (typeof code !== 'string') return '';
  // Support both compact and spaced versions
  const match = /eval\(function\s*\(p,a,c,k,e,d\)\{[\s\S]*?return\s+p;?\s*\}\s*\(\s*(['"])(.*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])(.*?)\5\.split\(\s*(['"])\|\7\s*\)\s*/.exec(code);
  if (!match) return "NO MATCH";

  let p = match[2];
  let a = parseInt(match[3], 10);
  let c = parseInt(match[4], 10);
  let k = match[6].split('|');

  const e = (val) => {
    return (val < a ? '' : e(Math.floor(val / a))) + ((val %= a) > 35 ? String.fromCharCode(val + 29) : val.toString(36));
  };

  const d = {};
  while (c--) {
    d[e(c)] = k[c] || e(c);
  }

  return p.replace(/\b(\w+)\b/g, (w) => d[w] || w);
}

const sample = `eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c]);return p}('b 6m=[];b n={\"15\":\"1d://6s.dr.dq/3c/15/45/6r/6q/6p.dp\"}', 36, 100, '|||||||||||var|||file|https'.split('|')))`;

console.log("Testing unpack...");
const result = unpackJs(sample);
console.log("RESULT:", result);
if (result.includes("https")) console.log("SUCCESS: Unpacked correctly");
else console.log("FAILURE: Not unpacked");
