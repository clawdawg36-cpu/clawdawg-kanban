import { useState, useEffect, useCallback, useRef } from 'react';
import { listAttachments, uploadAttachment, deleteAttachment } from '../../api/attachments';
import ConfirmDialog from './ConfirmDialog';
import styles from './Attachments.module.css';

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function Attachments({ taskId }) {
  const [items, setItems] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await listAttachments(taskId);
      setItems(Array.isArray(data) ? data : (data.items || []));
    } catch (err) {
      console.error('Failed to load attachments:', err);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0 || !taskId) return;
    setUploading(true);
    try {
      for (const file of files) {
        await uploadAttachment(taskId, file);
      }
      fileRef.current.value = '';
      load();
    } catch (err) {
      console.error('Failed to upload:', err);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteAttachment(confirmDelete);
      setItems(prev => prev.filter(a => a.id !== confirmDelete));
    } catch (err) {
      console.error('Failed to delete attachment:', err);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className={styles.section}>
      <span className={styles.label}>{'\u{1F4CE}'} Attachments</span>
      <div className={styles.list}>
        {items.length === 0 && (
          <div className={styles.empty}>No attachments yet.</div>
        )}
        {items.map(att => (
          <div key={att.id} className={styles.item}>
            <span className={styles.icon}>{'\u{1F4C4}'}</span>
            <div className={styles.meta}>
              <a
                className={styles.name}
                href={att.url || `/api/attachments/${att.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
                download
              >
                {att.filename || att.name}
              </a>
              {att.size != null && (
                <span className={styles.size}>{formatSize(att.size)}</span>
              )}
            </div>
            <button
              className={styles.removeBtn}
              onClick={() => setConfirmDelete(att.id)}
              aria-label={`Delete ${att.filename || att.name}`}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className={styles.uploadRow}>
        <input
          ref={fileRef}
          type="file"
          className={styles.fileInput}
          multiple
        />
        <button
          className={styles.uploadBtn}
          onClick={handleUpload}
          disabled={uploading}
        >
          {uploading ? 'Uploading...' : 'Upload'}
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Attachment"
          message="Are you sure you want to delete this attachment?"
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
