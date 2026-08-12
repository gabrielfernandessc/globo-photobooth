/* ══════════════════════════════════════════════════════════
   REDE — descobrir o endereço que o celular consegue alcançar

   O operador não deveria digitar IP nenhum. Para isso o servidor
   precisa saber, ele mesmo, em qual endereço da LAN está — e escolher
   bem: uma máquina de evento costuma ter VPN corporativa, adaptador de
   virtualização e Wi-Fi ao mesmo tempo, e só um deles é alcançável pelo
   celular na mesma rede.
   ══════════════════════════════════════════════════════════ */

const os = require('os');

/* Interfaces que existem na máquina mas não levam ao celular. Uma VPN
   corporativa aparece antes do Wi-Fi em muitos notebooks e é a origem
   clássica do "o QR não conecta". */
const INTERFACES_IGNORADAS = /^(utun|tun|tap|ppp|vmnet|vboxnet|docker|br-|veth|zt|wg|Hyper-V|VMware|VirtualBox|Loopback)/i;

/** Endereços IPv4 privados, os únicos que valem numa LAN de evento. */
function ehRedePrivada(ip) {
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/**
 * Endereços da LAN, do mais provável para o menos.
 *
 * A ordenação importa: o primeiro da lista é o que vai para o QR de
 * pareamento, e errar significa um operador tentando conectar um
 * celular num endereço que não responde.
 */
function lanAddresses() {
  const candidatos = [];

  for (const [nome, enderecos] of Object.entries(os.networkInterfaces())) {
    if (INTERFACES_IGNORADAS.test(nome)) continue;

    for (const item of enderecos || []) {
      if (!item || item.family !== 'IPv4' || item.internal) continue;
      // 169.254.x.x é auto-atribuído: significa que o DHCP falhou.
      if (item.address.startsWith('169.254.')) continue;

      candidatos.push({
        address: item.address,
        interface: nome,
        privada: ehRedePrivada(item.address),
      });
    }
  }

  return candidatos
    .sort((a, b) => {
      if (a.privada !== b.privada) return a.privada ? -1 : 1;
      // 192.168 é o range doméstico/evento mais comum.
      const domestico = ip => (ip.startsWith('192.168.') ? 0 : 1);
      return domestico(a.address) - domestico(b.address);
    })
    .map(c => c.address);
}

/** O endereço que vai no QR. Null quando a máquina está sem rede. */
function primaryLanAddress() {
  return lanAddresses()[0] || null;
}

module.exports = { lanAddresses, primaryLanAddress, ehRedePrivada };
