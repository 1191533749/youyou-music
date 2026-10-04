/**
 * Shown by pages that are still being built, so the shell stays navigable
 * while the feature set fills in. Replacing a page means replacing this import.
 */
export default function PagePlaceholder({
  title,
  hint
}: {
  title: string
  hint?: string
}): JSX.Element {
  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">{title}</h1>
      </div>
      <div className="placeholder">
        <div className="placeholder__title">此页面正在开发中</div>
        {hint ? <div>{hint}</div> : null}
      </div>
    </div>
  )
}
