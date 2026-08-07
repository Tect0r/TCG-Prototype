import { useAppActions, useAppState } from '../state/AppContext.js';
import { IssueList } from './IssueList.js';

export function NoticeBar() {
  const { notice } = useAppState();
  const { dismissNotice } = useAppActions();

  if (!notice) return null;

  return (
    <div
      className={`notice notice--${notice.tone}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      <div className="notice__body">
        <p>{notice.message}</p>
        {notice.details && notice.details.length > 0 && <IssueList issues={notice.details} />}
      </div>
      <button type="button" onClick={dismissNotice} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}
