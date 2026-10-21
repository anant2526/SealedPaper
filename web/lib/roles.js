// Where each role lands after logging in, and the navigation it sees.
export const ROLE_NAMES = {
  admin: 'Exam controller',
  setter: 'Paper setter',
  custodian: 'Key custodian',
  superintendent: 'Centre superintendent',
  investigator: 'Investigator',
};
export const roleName = (r) => ROLE_NAMES[r] || r;

export function homeFor(role) {
  if (role === 'custodian') return '/dashboard';
  if (role === 'investigator') return '/leaks';
  return '/papers';
}

export function navFor(role) {
  switch (role) {
    case 'admin':
      return [
        { href: '/papers', label: 'Papers' },
        { href: '/dashboard', label: 'Vault' },
        { href: '/centres', label: 'Centres' },
        { href: '/admin/users', label: 'People' },
        { href: '/leaks', label: 'Leaks' },
        { href: '/audit', label: 'Audit log' },
      ];
    case 'setter':
      return [{ href: '/papers', label: 'My papers' }];
    case 'custodian':
      return [{ href: '/dashboard', label: 'My keys' }, { href: '/papers', label: 'Papers' }];
    case 'superintendent':
      return [{ href: '/papers', label: 'My centres' }];
    case 'investigator':
      return [{ href: '/leaks', label: 'Leaks' }, { href: '/papers', label: 'Papers' }, { href: '/audit', label: 'Audit log' }];
    default:
      return [];
  }
}
