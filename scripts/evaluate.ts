import { evaluateCorpus } from "../src/lib/execution/evaluate";
const report = evaluateCorpus();
console.log(JSON.stringify(report, null, 2));
if (
  report.synthetic.passed !== report.synthetic.cases ||
  report.publicHeadlines.passed !== report.publicHeadlines.cases
)
  process.exitCode = 1;
