import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import css from './Ticket.module.css';

/**
 * Contenido de 80 mm que solo se ve al imprimir (window.print()). Es una constancia interna:
 * el comprobante electrónico oficial es el PDF que genera API-PRO.
 */
export function ZonaImpresion({ children }: { children: ReactNode }) {
  return createPortal(
    <div className={css.zona} data-impresion>
      {children}
    </div>,
    document.body,
  );
}

export function Ticket({ children }: { children: ReactNode }) {
  return <div className={css.ticket}>{children}</div>;
}

export function FilaTicket({ izquierda, derecha, fuerte }: { izquierda: ReactNode; derecha?: ReactNode; fuerte?: boolean }) {
  return (
    <div className={css.fila} data-fuerte={fuerte}>
      <span>{izquierda}</span>
      {derecha !== undefined && <span>{derecha}</span>}
    </div>
  );
}

export const SeparadorTicket = () => <div className={css.separador} />;
