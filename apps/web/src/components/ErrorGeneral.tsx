import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';

/**
 * Último recurso ante un error de la interfaz: en vez de una pantalla en blanco, un aviso con la
 * opción de recargar. Los datos ya guardados no se pierden (viven en el servidor).
 */
export class ErrorGeneral extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Error de la interfaz', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-dvh place-items-center bg-background p-4">
        <Card className="w-full max-w-md gap-3 p-6 text-center">
          <AlertTriangle className="mx-auto size-8 text-destructive" aria-hidden />
          <h1 className="text-lg font-bold">Algo salió mal en la pantalla</h1>
          <p className="text-sm text-muted-foreground">
            Lo que ya guardaste está a salvo. Recarga para continuar; si se repite, avisa al administrador.
          </p>
          <code className="rounded-md bg-muted px-2 py-1 text-xs break-words">{this.state.error.message}</code>
          <Button onClick={() => window.location.reload()}>Recargar</Button>
        </Card>
      </div>
    );
  }
}
