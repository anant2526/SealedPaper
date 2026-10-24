// Where each role lands after logging in, and the navigation it sees.
export const ROLE_NAMES = {
  admin: 'Controller',
  setter: 'Paper setter',
  custodian: 'Key custodian',
  superintendent: 'Centre superintendent',
  investigator: 'Investigator',
};
export const roleName = (r) => ROLE_NAMES[r] || r;

export function homeFor(role) {
  if (role === 'custodian' || role === 'admin') return '/dashboard';
  if (role === 'investigator') return '/leaks';
  return '/papers';
}

export function navFor(role) {
  switch (role) {
    case 'admin':
      return [
        { href: '/dashboard', label: 'Documents' },
        { href: '/papers', label: 'Exam papers' },
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
      return [{ href: '/leaks', label: 'Leaks' }, { href: '/dashboard', label: 'Documents' }, { href: '/papers', label: 'Exam papers' }, { href: '/audit', label: 'Audit log' }];
    default:
      return [];
  }
}
