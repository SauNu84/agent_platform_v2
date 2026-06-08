/**
 * AnalysisReport — presentational view of an Analyst report (report card + final
 * score + strengths/weaknesses + improvement plan). Used in History (and reusable
 * by the detail shell). Pure props in; no hooks, so it renders on server or client.
 */
import type { AnalysisRecord } from '@/domain/analysis';

export default function AnalysisReport({ analysis }: { analysis: AnalysisRecord }) {
  const { evaluation, improvement } = analysis;
  return (
    <div className="analysis">
      <div className="score-head">
        <div className="final-score">
          <span className="score-num">{Math.round(evaluation.finalScore)}</span>
          <span className="score-den">/100</span>
        </div>
        <span className="scorer">scored by {analysis.scorer}</span>
      </div>

      {evaluation.reportCard.length > 0 && (
        <table>
          <thead><tr><th>Topic</th><th>Score</th><th>Weight</th><th>Note</th></tr></thead>
          <tbody>
            {evaluation.reportCard.map((r, i) => (
              <tr key={i}>
                <td>{r.topic}</td>
                <td className={r.score >= 70 ? 'good' : 'warn'}>{r.score}</td>
                <td>{r.weight}</td>
                <td>{r.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="cols">
        <div>
          <h4>Strengths</h4>
          {evaluation.strengths.length ? (
            <ul>{evaluation.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
          ) : <p className="empty">None flagged.</p>}
        </div>
        <div>
          <h4>Weaknesses</h4>
          {evaluation.weaknesses.length ? (
            <ul>{evaluation.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
          ) : <p className="empty">None flagged.</p>}
        </div>
      </div>

      {improvement.actionItems.length > 0 && (
        <>
          <h4>Improvement plan</h4>
          <ul>{improvement.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      )}
    </div>
  );
}
