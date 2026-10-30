import { Construction } from 'lucide-react';
import { Card } from '@/components/ui/card';

export function EnConstruccion({ titulo }: { titulo: string }) {
  return (
    <>
      <h1 style={{ marginBottom: '1.5rem' }}>{titulo}</h1>
      <Card className="gap-3" style={{ display: 'grid', placeItems: 'center', gap: '0.5rem', padding: '3rem 1rem', textAlign: 'center' }}>
        <Construction size={24} strokeWidth={2.5} color="var(--primary)" aria-hidden />
        <p className="muted" style={{ margin: 0 }}>
          Esta sección se construye en una fase posterior del plan.
        </p>
      </Card>
    </>
  );
}
