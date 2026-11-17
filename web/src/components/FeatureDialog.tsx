import { useEffect, useState } from 'react';
import type { Feature, Priority } from '@shared/types.ts';
import { api } from '@/api';
import { upsertFeature, useStore } from '@/store';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, Input, Select } from './ui/input';
import { MentionTextarea } from './MentionTextarea';
import { toastError } from './toast';

export function FeatureDialog({
  open,
  onOpenChange,
  projectId,
  feature,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  feature?: Feature | null;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [brainstorm, setBrainstorm] = useState(true);
  const allFeatures = useStore((s) => s.features);
  const candidates = Object.values(allFeatures)
    .filter((f) => f.projectId === projectId && f.id !== feature?.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  useEffect(() => {
    if (open) {
      setTitle(feature?.title ?? '');
      setDescription(feature?.description ?? '');
      setPriority(feature?.priority ?? 'medium');
      setDependsOn(feature?.dependsOn ?? []);
    }
  }, [open, feature]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      let f = feature
        ? await api.updateFeature(feature.id, { title, description, priority })
        : await api.createFeature(projectId, { title, description, priority, brainstorm });
      const before = feature?.dependsOn ?? [];
      if (dependsOn.length !== before.length || dependsOn.some((d) => !before.includes(d))) f = await api.setDependencies(f.id, dependsOn);
      upsertFeature(f);
      onOpenChange(false);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{feature ? `Edit ticket${feature.issueNumber ? ` #${feature.issueNumber}` : ''}` : 'New ticket'}</DialogTitle>
            <DialogDescription>
              {feature
                ? feature.issueNumber
                  ? 'Saving updates the GitHub issue too.'
                  : 'This ticket is not on GitHub yet.'
                : 'Say what you want. With brainstorming on, Claude reads the code, writes the GitHub issue with you and asks you about the real choices.'}
            </DialogDescription>
          </DialogHeader>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Portfolio charts" autoFocus required />
          </Field>
          {!feature && (
            <label className="metal-raised flex cursor-pointer items-start gap-2 rounded-xl border p-2.5">
              <input type="checkbox" className="mt-0.5" checked={brainstorm} onChange={(e) => setBrainstorm(e.target.checked)} />
              <span>
                <span className="block text-sm font-medium">Brainstorm with Claude</span>
                <span className="block text-[11px] text-muted-foreground">
                  On: your notes open a chat and Claude writes the issue. Off: the ticket is created on GitHub exactly as written below.
                </span>
              </span>
            </label>
          )}
          <Field label={feature || !brainstorm ? 'Issue text' : 'Notes for Claude'} hint="Markdown. Type @ to reference a repository file.">
            <MentionTextarea
              projectId={projectId}
              value={description}
              onChange={setDescription}
              rows={12}
              className="font-mono text-xs"
              placeholder={brainstorm && !feature ? 'Rough is fine: what, why, anything you already know about where it lives in the code.' : '## Why\n\n## What\n\n## Edge cases\n\n## Data\n\n## Acceptance\n- [ ] …'}
            />
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="w-40">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
          {candidates.length > 0 && (
            <Field label="Depends on" hint="This ticket waits in the queue until these are Done (merged). Branches are never stacked. A “Depends on #n” line in the issue sets this too.">
              <div className="metal-inset max-h-40 space-y-1 overflow-y-auto rounded-xl p-2">
                {candidates.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-foreground/[0.05]">
                    <input
                      type="checkbox"
                      checked={dependsOn.includes(c.id)}
                      onChange={(e) => setDependsOn((d) => (e.target.checked ? [...d, c.id] : d.filter((x) => x !== c.id)))}
                    />
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{c.status}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {feature ? 'Save' : brainstorm ? 'Start brainstorming' : 'Create ticket'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
