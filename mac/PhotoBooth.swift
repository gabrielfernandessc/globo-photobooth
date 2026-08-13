/* ══════════════════════════════════════════════════════════
   GLOBO PHOTO BOOTH — app nativo do totem

   O miolo continua sendo o servidor Node: pipeline de imagem, SQLite,
   fila de publicação e ponte com a câmera já estão medidos com a
   câmera real, e reescrevê-los em Swift trocaria código provado por
   código novo sem resolver nada — o gargalo é o PTP da câmera, que
   seria idêntico aqui.

   O que este app resolve é o que ser web custava:

     · o Chrome deixa de ser dependência
     · não existe barra, aba, ESC nem menu para o convidado mexer
     · um processo no Dock, não dois
     · o servidor sobe e morre junto com a janela

   A tela é a mesma /totem.html, dentro de um WKWebView em tela cheia.
   ══════════════════════════════════════════════════════════ */

import Cocoa
import WebKit

let PORTA = ProcessInfo.processInfo.environment["PHOTOBOOTH_PORT"] ?? "3000"

/// Onde o repositório mora. Fixado na compilação para o .app poder ser
/// movido para /Applications sem perder de vista o projeto.
let REPO = ProcessInfo.processInfo.environment["PHOTOBOOTH_REPO"] ?? "__REPO__"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {

    var janela: NSWindow!
    var web: WKWebView!
    var servidor: Process?
    var log: FileHandle?

    // MARK: - Ciclo de vida

    func applicationDidFinishLaunching(_ notification: Notification) {
        abrirLog()
        montarJanela()

        guard let node = acharNode() else {
            falhar("O Node.js não foi encontrado.",
                   "Instale a versão 22 ou maior em nodejs.org e abra o Photo Booth de novo.")
            return
        }

        if portaOcupada() {
            falhar("A porta \(PORTA) já está ocupada.",
                   "O Photo Booth provavelmente já está aberto. Encerre-o antes de abrir de novo.")
            return
        }

        liberarCamera()
        subirServidor(node: node)
        esperarServidor()
    }

    /// Encerrar a janela encerra o evento: sem isto o Node sobreviveria
    /// ao app e a próxima abertura acharia a porta ocupada.
    func applicationWillTerminate(_ notification: Notification) {
        encerrarServidor()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        return true
    }

    // MARK: - Janela

    private func montarJanela() {
        let tela = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)

        // .borderless: o totem não tem barra de título para arrastar nem
        // botão de fechar ao alcance de um convidado curioso.
        janela = NSWindow(contentRect: tela,
                          styleMask: [.borderless],
                          backing: .buffered,
                          defer: false)
        janela.level = .normal
        janela.backgroundColor = .white
        janela.isOpaque = true
        janela.collectionBehavior = [.fullScreenPrimary]

        let config = WKWebViewConfiguration()
        // O preview é MJPEG numa <img>; nada precisa de gesto do usuário
        // para começar a tocar.
        config.mediaTypesRequiringUserActionForPlayback = []

        web = WKWebView(frame: tela, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        // Sem menu de contexto e sem seleção: é um totem, não um site.
        web.configuration.preferences.setValue(false, forKey: "javaScriptCanOpenWindowsAutomatically")

        janela.contentView = web
        janela.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        mostrar(html: telaDeEspera(mensagem: "Preparando o totem…"))
    }

    /// Tela local enquanto o servidor não responde. Sem ela o operador
    /// veria uma janela branca sem saber se travou.
    private func telaDeEspera(mensagem: String, detalhe: String = "") -> String {
        return """
        <!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:#fff;color:#000;
          font-family:-apple-system,system-ui,sans-serif;
          display:grid;place-items:center;text-align:center;user-select:none}
        h1{font-size:min(6vw,72px);font-weight:700;margin:0 0 .3em}
        p{font-size:min(2.2vw,26px);color:#939598;margin:0;line-height:1.4}
        .barra{position:fixed;left:0;right:0;bottom:0;height:32px;
          background:linear-gradient(90deg,#05A6FF 0%,#8800F8 33.33%,#FF0C1F 67%,#FFD006 100%)}
        </style></head><body><div><h1>\(mensagem)</h1><p>\(detalhe)</p></div>
        <div class="barra"></div></body></html>
        """
    }

    private func mostrar(html: String) {
        DispatchQueue.main.async { self.web.loadHTMLString(html, baseURL: nil) }
    }

    // MARK: - Node

    /// Um app aberto pelo Finder recebe um PATH mínimo, sem Homebrew —
    /// por isso o node é procurado nos caminhos conhecidos.
    private func acharNode() -> String? {
        let candidatos = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        return candidatos.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func portaOcupada() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-ti", ":\(PORTA)", "-sTCP:LISTEN"]
        let saida = Pipe()
        p.standardOutput = saida
        p.standardError = Pipe()
        try? p.run()
        p.waitUntilExit()
        let dados = saida.fileHandleForReading.readDataToEndOfFile()
        return !dados.isEmpty
    }

    /// O macOS assume a câmera PTP assim que ela conecta e o gphoto2
    /// recebe "could not claim the USB device".
    private func liberarCamera() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        p.arguments = ["-x", "PTPCamera"]
        p.standardError = Pipe()
        try? p.run()
        p.waitUntilExit()
    }

    private func subirServidor(node: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server.js"]
        p.currentDirectoryURL = URL(fileURLWithPath: REPO)

        var ambiente = ProcessInfo.processInfo.environment
        ambiente["PORT"] = PORTA
        ambiente["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = ambiente

        if let log = log {
            p.standardOutput = log
            p.standardError = log
        }

        do {
            try p.run()
            servidor = p
            escrever("servidor subindo (PID \(p.processIdentifier))")
        } catch {
            falhar("O servidor não pôde ser iniciado.", error.localizedDescription)
        }
    }

    /// Espera o servidor RESPONDER, não apenas o processo existir:
    /// processo vivo com porta muda é o pior estado para quem opera.
    private func esperarServidor() {
        DispatchQueue.global(qos: .userInitiated).async {
            let limite = Date().addingTimeInterval(45)
            let saude = URL(string: "http://localhost:\(PORTA)/api/health")!

            while Date() < limite {
                if let processo = self.servidor, !processo.isRunning {
                    self.falhar("O servidor fechou sozinho durante o boot.",
                                "Veja o log em \(REPO)/logs/")
                    return
                }

                var pronto = false
                let espera = DispatchSemaphore(value: 0)
                var req = URLRequest(url: saude)
                req.timeoutInterval = 2

                URLSession.shared.dataTask(with: req) { dados, resposta, _ in
                    if let http = resposta as? HTTPURLResponse, http.statusCode == 200, dados != nil {
                        pronto = true
                    }
                    espera.signal()
                }.resume()

                _ = espera.wait(timeout: .now() + 3)

                if pronto {
                    self.escrever("servidor no ar")
                    DispatchQueue.main.async {
                        let url = URL(string: "http://localhost:\(PORTA)/totem.html")!
                        self.web.load(URLRequest(url: url))
                    }
                    return
                }

                Thread.sleep(forTimeInterval: 0.5)
            }

            self.falhar("O servidor não respondeu em 45 segundos.", "Veja o log em \(REPO)/logs/")
        }
    }

    private func encerrarServidor() {
        guard let p = servidor, p.isRunning else { return }
        escrever("encerrando o servidor")

        // SIGTERM para o SQLite fechar o WAL e os streams de preview
        // caírem; só depois se força.
        p.terminate()
        let limite = Date().addingTimeInterval(5)
        while p.isRunning && Date() < limite {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    // MARK: - Erros e log

    private func falhar(_ oQue: String, _ comoResolver: String) {
        escrever("ERRO: \(oQue) — \(comoResolver)")
        mostrar(html: telaDeEspera(mensagem: oQue, detalhe: comoResolver))

        DispatchQueue.main.async {
            let alerta = NSAlert()
            alerta.messageText = "Photo Booth não abriu"
            alerta.informativeText = "\(oQue)\n\n\(comoResolver)"
            alerta.alertStyle = .critical
            alerta.addButton(withTitle: "Fechar")
            alerta.runModal()
            NSApp.terminate(nil)
        }
    }

    private func abrirLog() {
        let dir = "\(REPO)/logs"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        let caminho = "\(dir)/totem-\(f.string(from: Date())).log"

        if !FileManager.default.fileExists(atPath: caminho) {
            FileManager.default.createFile(atPath: caminho, contents: nil)
        }
        log = FileHandle(forWritingAtPath: caminho)
        log?.seekToEndOfFile()
    }

    private func escrever(_ texto: String) {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        let linha = "[\(f.string(from: Date()))] \(texto)\n"
        log?.write(linha.data(using: .utf8)!)
        FileHandle.standardOutput.write(linha.data(using: .utf8)!)
    }
}

// MARK: - Boot

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)

/* Atalhos do operador. CMD+Q encerra; CMD+R recarrega o telão sem
   derrubar o servidor, que é o que se quer quando a tela trava mas o
   evento continua. Nada disso está num menu visível: o convidado não
   deve encontrar caminho para sair. */
let menu = NSMenu()
let item = NSMenuItem()
let submenu = NSMenu()
submenu.addItem(withTitle: "Recarregar telão", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
submenu.addItem(NSMenuItem.separator())
submenu.addItem(withTitle: "Encerrar Photo Booth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
item.submenu = submenu
menu.addItem(item)
app.mainMenu = menu

app.run()
