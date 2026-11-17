import type { StudentFlow } from './flow.ts';

/** Existing server profile PATCH, never a new identity or optimistic local rename. */
export async function saveDashboardProfile(flow: StudentFlow, person: string, firstName: string, lastName: string): Promise<boolean> {
  const first = firstName.trim(), last = lastName.trim();
  if (!first || !last || first.length > 100 || last.length > 100 || flow.state.student?.person !== person) return false;
  let saved = false;
  await flow.run(async () => {
    const updated = await flow.port.register(first, last);
    if (flow.state.student?.person !== person || updated.person !== person) return;
    flow.patch({ student: updated });
    saved = true;
  });
  return saved;
}
