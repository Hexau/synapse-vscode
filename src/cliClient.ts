import * as vscode from 'vscode';
import { SynapseWsClient, createLocalFileOpHandler, createLocalExecOpHandler } from '@synapse/protocol';

export type CliStatusCallback = (connected: boolean) => void;

/**
 * Thin wrapper around @synapse/protocol's SynapseWsClient: both the
 * WS/socket.io/connector_hello plumbing AND the local filesystem/exec
 * handlers now live in the shared package (createLocalFileOpHandler /
 * createLocalExecOpHandler), also used by the Synapse CLI — this class is
 * just VSCode-specific wiring (constructor signature, updateContextId/
 * updateApiToken forwarding) on top of that.
 */
export class CliClient {
    private ws: SynapseWsClient;
    private apiToken = '';

    constructor(serverUrl: string, onStatus?: CliStatusCallback) {
        this.ws = new SynapseWsClient({
            serverUrl,
            onStatus,
            // La raíz debe ser la carpeta abierta, no `process.cwd()`: el cwd
            // del host de extensiones es el directorio de instalación de
            // VSCode, así que las rutas relativas del agente terminaban
            // escribiéndose ahí en vez de en el proyecto.
            // Se consulta en cada operación (no se captura una vez) porque el
            // usuario puede cambiar de carpeta sin reiniciar la extensión.
            fileOpHandler: createLocalFileOpHandler(
                () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ),
            // Misma raiz que las operaciones de archivo: sin ella los comandos
            // corren en el directorio de instalacion de VSCode, donde `git`
            // responde que no hay repositorio y los `rm` relativos no borran
            // nada — ambos fallos observados en corridas reales de openwiki.
            execOpHandler: createLocalExecOpHandler(
                () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ),
        });
    }

    start() {
        this.ws.start();
    }

    updateContextId(id: string) {
        this.ws.updateContextId(id);
    }

    // Fase 4 del plan de sesiones aisladas: token de API por usuario
    // (Command Palette → "Synapse: Set API Token"), obtenido desde
    // /api/my_account en el WebUI tras loguearse. Sin esto, en modo
    // multi-usuario el servidor no puede saber a qué cuenta pertenece esta
    // ventana de VSCode.
    updateApiToken(token: string) {
        this.apiToken = token || '';
        this.ws.updateApiToken(this.apiToken);
    }

    dispose() {
        this.ws.stop();
    }
}
