// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { Button, Input, Space, Tooltip, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';

const { Text } = Typography;

interface EditableRefCellProps {
  /** The reference as it stands, or undefined when nothing has set it. */
  value?: string;
  /** Whether this caller may change it. A reader still sees the value. */
  editable: boolean;
  /** Saves the new value. An empty string means "clear this reference". */
  onSave: (next: string) => Promise<void>;
  /** How wide the input is while editing. It has to leave room for the two buttons beside it
      inside the table cell, which is why the default is well under the column's own width. */
  width?: number;
}

/**
 * One table cell holding a short reference somebody may edit in place.
 *
 * Follows the rename control in the workstation table: the pencil opens it, Enter or the tick
 * saves, Escape or the cross abandons. It differs in the one way that matters here — an empty
 * value is a real answer, and saving one clears the reference, because both the workstation and
 * the storage API read '' as "remove this attribute" rather than "store nothing".
 */
export default function EditableRefCell({ value, editable, onSave, width = 140 }: EditableRefCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const commit = async () => {
    const next = draft.trim();
    if (next === (value || '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <Space size={4}>
        <Input
          size="small"
          autoFocus
          disabled={saving}
          value={draft}
          placeholder="Empty to clear"
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          style={{ width }}
        />
        <Tooltip title="Save (Enter)">
          <Button
            type="text"
            size="small"
            loading={saving}
            icon={saving ? undefined : <CheckOutlined style={{ color: '#52c41a', fontSize: 12 }} />}
            onClick={commit}
          />
        </Tooltip>
        <Tooltip title="Cancel (Esc)">
          <Button
            type="text"
            size="small"
            disabled={saving}
            icon={<CloseOutlined style={{ color: '#ff4d4f', fontSize: 12 }} />}
            onClick={() => setEditing(false)}
          />
        </Tooltip>
      </Space>
    );
  }

  return (
    <Space size={4}>
      {value ? (
        <Tooltip title={value}>
          <Text style={{ fontSize: 12 }}>{value}</Text>
        </Tooltip>
      ) : (
        <Text type="secondary">—</Text>
      )}
      {editable && (
        <Tooltip title="Edit">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined style={{ fontSize: 12, opacity: 0.45 }} />}
            onClick={(e) => {
              e.stopPropagation();
              setDraft(value || '');
              setEditing(true);
            }}
          />
        </Tooltip>
      )}
    </Space>
  );
}
