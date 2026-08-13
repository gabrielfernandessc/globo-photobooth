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

   O painel do operador e o telão são WKWebViews separados: o primeiro
   fica no Mac e o segundo abre no monitor externo.
   ══════════════════════════════════════════════════════════ */

import Cocoa
import WebKit

let PORTA = ProcessInfo.processInfo.environment["PHOTOBOOTH_PORT"] ?? "3000"

/// Onde o repositório mora. Fixado na compilação para o .app poder ser
/// movido para /Applications sem perder de vista o projeto.
let REPO = ProcessInfo.processInfo.environment["PHOTOBOOTH_REPO"] ?? "__REPO__"

/**
 Janela sem borda que ainda aceita foco.

 O macOS recusa dar status de "chave" a uma janela `.borderless` — é o
 padrão para paletas e HUDs, que não devem roubar o teclado. Num totem
 isso quebra tudo de uma vez: a janela não se apresenta direito e a
 barra de espaço, que é o gatilho da foto, nunca chega ao conteúdo.
 */
final class JanelaDoTotem: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {

    var janelaTelao: NSWindow!
    var janelaControle: NSWindow!
    var webTelao: WKWebView!
    var webControle: WKWebView!
    var servidor: Process?
    var log: FileHandle?

    // MARK: - Ciclo de vida

    func applicationDidFinishLaunching(_ notification: Notification) {
        abrirLog()
        montarJanelas()

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

    /* Falso de propósito: se a janela sumir por qualquer motivo — tela
       externa que desliga, monitor desconectado no meio do evento — o
       totem não pode se encerrar junto e levar o servidor com ele. */
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool {
        return false
    }

    // MARK: - Janela

    /**
     Em qual tela o totem abre.

     Num evento há duas: a do Mac, onde o operador trabalha, e o telão
     ligado por HDMI. O convidado olha o telão — então é ele que recebe
     a tela cheia, e o operador fica com a máquina livre para o painel
     e para o Finder.

     A tela com a barra de menus é sempre a principal do sistema; a
     outra é a externa. Com uma tela só, não há escolha a fazer.

     PHOTOBOOTH_TELA=principal força o comportamento antigo, para quando
     o Mac estiver ligado direto na TV sem segundo monitor.
     */
    /// Move a janela para a tela pedida (1 = Mac, 2 = externa).
    @objc func irParaTela(_ item: NSMenuItem) {
        let telas = NSScreen.screens
        guard item.tag >= 1, item.tag <= telas.count else { return }
        let alvo = telas[item.tag - 1].visibleFrame

        if janelaTelao.styleMask.contains(.fullScreen) { janelaTelao.toggleFullScreen(nil) }
        janelaTelao.setFrame(alvo, display: true, animate: true)
        janelaTelao.makeKeyAndOrderFront(nil)
        escrever("telão movido para a tela \(item.tag) (\(Int(alvo.width))x\(Int(alvo.height)))")
    }

    @objc func alternarTelaCheia() {
        janelaTelao.toggleFullScreen(nil)
    }

    @objc func mostrarControle() {
        janelaControle.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func mostrarTelao() {
        janelaTelao.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func recarregarTelas() {
        webControle.reload()
        webTelao.reload()
    }

    private func telaDoTotem() -> NSRect {
        let telas = NSScreen.screens
        let padrao = NSScreen.screens.first?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)

        if ProcessInfo.processInfo.environment["PHOTOBOOTH_TELA"] == "principal" { return padrao }
        guard telas.count > 1, let principal = telas.first else { return padrao }

        let externa = telas.first { $0 != principal }
        if let externa = externa {
            escrever("telão na tela externa (\(Int(externa.frame.width))x\(Int(externa.frame.height)))")
            return externa.visibleFrame
        }
        return padrao
    }

    private func configurarWeb() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.setValue(false, forKey: "javaScriptCanOpenWindowsAutomatically")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        return web
    }

    private func montarJanelas() {
        let telaTelao = telaDoTotem()
        let telaPrincipal = NSScreen.screens.first?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        /* Janela normal por padrão.
           A versão anterior nascia sem borda e em tela cheia, e o
           operador não tinha como fechar, mover nem escolher o monitor.
           Um totem que prende quem opera é pior que um totem que mostra
           a barra de título: a tela cheia agora é um modo (CMD+F), não
           uma imposição. */
        janelaTelao = JanelaDoTotem(contentRect: telaTelao,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered,
                          defer: false)
        janelaTelao.title = "Globo Photo Booth — Telão"
        janelaTelao.isReleasedWhenClosed = false
        /* Tela cheia de totem, não de aplicativo.
           Uma janela borderless do tamanho da tela AINDA fica debaixo do
           Dock e da barra de menus — eles aparecem por cima da foto,
           quebrando a ilusão e dando ao convidado onde clicar. Subir o
           nível acima do menu resolve a sobreposição; esconder os dois
           resolve o resto. */
        janelaTelao.backgroundColor = .white
        janelaTelao.isOpaque = true
        janelaTelao.collectionBehavior = [.fullScreenPrimary]
        webTelao = configurarWeb()
        janelaTelao.contentView = webTelao

        janelaControle = NSWindow(contentRect: telaPrincipal,
                                  styleMask: [.titled, .closable, .miniaturizable, .resizable],
                                  backing: .buffered,
                                  defer: false)
        janelaControle.title = "Globo Photo Booth — Controle"
        janelaControle.isReleasedWhenClosed = false
        janelaControle.backgroundColor = .white
        janelaControle.isOpaque = true
        janelaControle.collectionBehavior = [.fullScreenPrimary]
        webControle = configurarWeb()
        janelaControle.contentView = webControle

        janelaTelao.orderFront(nil)
        janelaControle.makeKeyAndOrderFront(nil)
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
        DispatchQueue.main.async {
            self.webTelao.loadHTMLString(html, baseURL: nil)
            self.webControle.loadHTMLString(html, baseURL: nil)
        }
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
        for processo in ["PTPCamera", "icdd"] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
            p.arguments = ["-x", processo]
            p.standardError = Pipe()
            try? p.run()
            p.waitUntilExit()
        }
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
                        let telão = URL(string: "http://localhost:\(PORTA)/totem.html")!
                        let controle = URL(string: "http://localhost:\(PORTA)/control.html?code=TOTM&embedded=1")!
                        self.webTelao.load(URLRequest(url: telão))
                        self.webControle.load(URLRequest(url: controle))
                        self.janelaControle.makeKeyAndOrderFront(nil)
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
/* Menu do operador.

   A versão anterior escondia a barra de menus e subia a janela acima
   dela — o app ficava sem saída, nem para fechar. Aqui tudo é
   alcançável: tela cheia, escolha de monitor e encerrar. */
let menu = NSMenu()

let itemApp = NSMenuItem()
let menuApp = NSMenu()
let recarregar = NSMenuItem(title: "Recarregar controle e telão", action: #selector(AppDelegate.recarregarTelas), keyEquivalent: "r")
recarregar.target = delegate
menuApp.addItem(recarregar)
let abrirControle = NSMenuItem(title: "Mostrar controle", action: #selector(AppDelegate.mostrarControle), keyEquivalent: "o")
abrirControle.target = delegate
menuApp.addItem(abrirControle)
let abrirTelao = NSMenuItem(title: "Mostrar telão", action: #selector(AppDelegate.mostrarTelao), keyEquivalent: "t")
abrirTelao.target = delegate
menuApp.addItem(abrirTelao)
menuApp.addItem(NSMenuItem.separator())
menuApp.addItem(withTitle: "Encerrar Photo Booth", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
itemApp.submenu = menuApp
menu.addItem(itemApp)

let itemTela = NSMenuItem()
itemTela.title = "Tela"
let menuTela = NSMenu(title: "Tela")

let cheia = NSMenuItem(title: "Tela cheia", action: #selector(AppDelegate.alternarTelaCheia), keyEquivalent: "f")
cheia.target = delegate
menuTela.addItem(cheia)
menuTela.addItem(NSMenuItem.separator())

// Um item por monitor, para o operador mandar o telão para a TV sem
// arrastar janela.
for (i, t) in NSScreen.screens.enumerated() {
    let nome = "Tela \(i + 1) — \(Int(t.frame.width))×\(Int(t.frame.height))"
    let item = NSMenuItem(title: nome, action: #selector(AppDelegate.irParaTela(_:)), keyEquivalent: "\(i + 1)")
    item.tag = i + 1
    item.target = delegate
    menuTela.addItem(item)
}

itemTela.submenu = menuTela
menu.addItem(itemTela)
app.mainMenu = menu

app.run()
