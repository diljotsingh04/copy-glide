import logoUrl from '../assets/logo.svg';

export function Logo({ size = 28 }: { size?: number }) {
  return <img className="logo" src={logoUrl} width={size} height={size} alt="" draggable={false} />;
}

export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`wordmark ${size}`}>
      Copy<span className="wordmark-glide">Glide</span>
    </span>
  );
}
