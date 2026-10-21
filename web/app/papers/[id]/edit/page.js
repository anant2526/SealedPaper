'use client';

import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/components/AuthProvider';
import PaperForm from '@/components/PaperForm';

export default function EditPaper() {
  const { id } = useParams();
  const { ready } = useRequireAuth(['admin']);
  if (!ready) return null;
  return <PaperForm paperId={id} />;
}
