import { Encabezado } from '../../components/ui';
import { TercerosLista } from './TercerosLista';

export function ClientesPage() {
  return (
    <>
      <Encabezado titulo="Clientes" />
      <TercerosLista recurso="clientes" />
    </>
  );
}
