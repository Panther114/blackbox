import React, { useLayoutEffect, useRef } from 'react';
import { Icon, AppIcon } from './Icons';
import { WindowControls } from './WindowControls';

export type WorkspaceView = 'download' | 'automation' | 'agent' | 'settings';

const destinations = [
  {
    id: 'download' as const,
    label: 'Downloads',
    hint: 'Courses, files and saving',
    icon: 'download' as const,
  },
  {
    id: 'automation' as const,
    label: 'Automation',
    hint: 'Batch G-number downloading',
    icon: 'scan' as const,
  },
  {
    id: 'agent' as const,
    label: 'Agent Skills',
    hint: 'Read-only tools and harnesses',
    icon: 'agent' as const,
  },
  {
    id: 'settings' as const,
    label: 'Settings',
    hint: 'Credentials, diagnostics and updates',
    icon: 'sliders' as const,
  },
];

/** One continuous selection underline; measurements are independent of workflow updates. */
export function WorkspaceNavigation({
  active,
  onNavigate,
}: {
  active: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const selectedIndex = destinations.findIndex(item => item.id === active);
  return (
    <header className="workspace-header" data-tauri-drag-region>
      <div className="workspace-brand">
        <AppIcon />
        <strong>Blackbox</strong>
        <span>blackboardchina downloader</span>
      </div>
      <nav className="workspace-nav" aria-label="Primary">
        <span
          className="nav-indicator"
          aria-hidden="true"
          style={{ transform: `translateX(${selectedIndex * 100}%)` }}
        />
        {destinations.map(item => (
          <Action
            key={item.id}
            className={`nav-item ${active === item.id ? 'is-active' : ''}`}
            aria-label={item.label}
            aria-current={active === item.id ? 'page' : undefined}
            title={item.hint}
            onClick={() => onNavigate(item.id)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </Action>
        ))}
      </nav>
      <WindowControls />
    </header>
  );
}

export function WorkspaceHeading({
  active,
  credentials,
  version,
  demo,
}: {
  active: WorkspaceView;
  credentials: boolean;
  version: string;
  demo: boolean;
}) {
  const item = destinations.find(item => item.id === active)!;
  return (
    <div className="workspace-heading">
      <h1>{item.label}</h1>
      <div className="workspace-status">
        {demo && <span className="pill pill-demo">Offline demo</span>}
        <span className={`pill ${credentials ? 'pill-ok' : 'pill-warn'}`}>
          <Icon name={credentials ? 'shield' : 'key'} size={13} />
          {credentials ? 'Credentials ready' : 'Credentials needed'}
        </span>
        <span className="sr-only">{version || 'Loading...'}</span>
      </div>
    </div>
  );
}

export function WorkspaceFooter({
  version,
  downloads,
  logs,
  onDownloads,
  onLogs,
}: {
  version: string;
  downloads: string;
  logs: string;
  onDownloads: () => void;
  onLogs: () => void;
}) {
  return (
    <footer className="workspace-footer">
      <span>v{version || '...'}</span>
      <div>
        <Action className="linklike" onClick={onDownloads} title={downloads}>
          Downloads
        </Action>
        <span className="sep">/</span>
        <Action className="linklike" onClick={onLogs} title={logs}>
          Logs
        </Action>
        <span className="footer-note">Educational use only. Use responsibly.</span>
      </div>
    </footer>
  );
}

/** Keep glass outside animated opacity/transform ancestors (CSS backdrop roots). */
export function Scene({ identity, children }: { identity: string; children: React.ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!element.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const targets = element.current.querySelectorAll<HTMLElement>('.panel > *, .banner');
    const animations = Array.from(targets, target =>
      target.animate(
        [
          { opacity: 0.65, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
      )
    );
    return () => animations.forEach(animation => animation.cancel());
  }, [identity]);
  return (
    <div className="scene" ref={element}>
      {children}
    </div>
  );
}

export function Surface({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={className} {...props} />;
}

export function Action({
  type = 'button',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`action ${className}`} {...props} />;
}
