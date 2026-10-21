'use client';

import { useRequireAuth } from '@/components/AuthProvider';
import PaperForm from '@/components/PaperForm';

export default function NewPaper() {
  const { ready } = useRequireAuth(['admin']);
  if (!ready) return null;
  return <PaperForm />;
}
