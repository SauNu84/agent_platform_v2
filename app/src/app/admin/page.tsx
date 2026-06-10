/**
 * Admin console (ADMIN ONLY) — the role-gated surface for Slice 5. A plain
 * `user` reaching this URL is redirected home (no platform_admin); an `admin`
 * sees the user/role roster. This is the UI half of the admin-only gate; the API
 * (/api/admin/users) and DB (RLS) enforce the same boundary.
 */
import { redirect } from 'next/navigation';
import { getStore } from '@/db';
import { requirePageActor } from '@/services/current-user';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const actor = await requirePageActor();
  if (!actor.isAdmin) redirect('/');

  const store = getStore();
  const users = await store.listUsers();
  const rows = await Promise.all(
    users.map(async (u) => ({ ...u, role: (await store.getUserRole(u.id)) ?? 'user' })),
  );

  return (
    <div>
      <h1>Admin · Users & roles</h1>
      <p className="subtitle">Platform administration (capability: platform_admin / manage_org_members).</p>
      <table className="data-table">
        <thead>
          <tr><th>Display name</th><th>Email</th><th>Role</th><th>Created</th></tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}</td>
              <td>{u.email}</td>
              <td><span className="role-badge">{u.role}</span></td>
              <td>{new Date(u.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
