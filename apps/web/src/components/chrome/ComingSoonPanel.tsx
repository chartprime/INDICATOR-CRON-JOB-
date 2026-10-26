interface ComingSoonPanelProps {
  title: string;
  description: string;
}

export function ComingSoonPanel({ title, description }: ComingSoonPanelProps) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-title">{title}</div>
      <div className="coming-soon-badge">Coming soon</div>
      <p className="coming-soon-description">{description}</p>
    </div>
  );
}
