import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 10;
const KILL_GRACE_MS = 1500;

function run(argv) {
    return new Promise((resolve, reject) => {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    resolve({ok: p.get_successful(), out: out ?? '', err: err ?? ''});
                } catch (e) {
                    reject(e);
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

function readCmdline(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        if (!ok)
            return [];
        return new TextDecoder().decode(bytes).split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

function readCwd(pid) {
    try {
        return GLib.file_read_link(`/proc/${pid}/cwd`);
    } catch {
        return '';
    }
}

function isAlive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
}

function prettyAddr(addr) {
    if (addr === '0.0.0.0' || addr === '::' || addr === '*')
        return 'todas';
    if (addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.'))
        return 'local';
    return addr;
}

// Salida de `ss -Htlnp`: State Recv-Q Send-Q Local Peer [users:(("name",pid=N,fd=M),...)]
function parseSs(out) {
    const byPort = new Map();
    for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5)
            continue;

        const local = cols[3];
        const sep = local.lastIndexOf(':');
        const port = parseInt(local.slice(sep + 1));
        if (Number.isNaN(port))
            continue;
        const addr = local.slice(0, sep).replace(/%[^\]]*/, '').replace(/^\[|\]$/g, '');

        let entry = byPort.get(port);
        if (!entry) {
            entry = {port, addrs: new Set(), procs: new Map()};
            byPort.set(port, entry);
        }
        entry.addrs.add(prettyAddr(addr));

        const procInfo = cols.slice(5).join(' ');
        for (const m of procInfo.matchAll(/\("([^"]+)",pid=(\d+)/g))
            entry.procs.set(parseInt(m[2]), m[1]);
    }

    // ss solo revela el pid de los procesos del usuario actual; sin pid es del sistema.
    return [...byPort.values()]
        .filter(e => e.procs.size > 0)
        .map(e => {
            const pids = [...e.procs.keys()];
            const argv = readCmdline(pids[0]);
            const cwd = readCwd(pids[0]);
            // ss muestra el nombre del hilo (p.ej. "MainThread" en node); el ejecutable es más útil.
            const exe = argv.length ? GLib.path_get_basename(argv[0]) : '';
            const names = exe ? [exe] : [...new Set(e.procs.values())];
            const project = cwd && cwd !== '/' && cwd !== GLib.get_home_dir()
                ? GLib.path_get_basename(cwd) : '';
            return {
                port: e.port,
                addrs: [...e.addrs],
                pids,
                names,
                project,
                cmd: argv.join(' '),
                cwd,
            };
        })
        .sort((a, b) => a.port - b.port);
}

const PortIndicator = GObject.registerClass(
class PortIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Port Killer');
        this._ext = ext;
        this._entries = [];
        this._error = null;
        this._sources = new Set();
        this._refreshToken = 0;

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${ext.path}/icons/port-killer-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
        this._tooltip = null;

        this._buildMenu();

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh();
            else
                this._hideTooltip();
        });

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            if (!this.menu.isOpen)
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    _buildMenu() {
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._search = new St.Entry({
            hint_text: 'Filtrar por puerto, proceso o carpeta…',
            can_focus: true,
            x_expand: true,
            style_class: 'port-killer-search',
        });
        this._search.clutter_text.connect('text-changed', () => this._render());
        searchItem.add_child(this._search);

        const refreshBtn = this._iconButton('view-refresh-symbolic', 'port-killer-btn', 'Actualizar');
        refreshBtn.connect('clicked', () => this._refresh());
        searchItem.add_child(refreshBtn);
        this.menu.addMenuItem(searchItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._section = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'port-killer-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.set_child(this._section.actor);
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scroll);
        this.menu.addMenuItem(scrollSection);
    }

    _iconButton(iconName, styleClass, tooltip) {
        const btn = new St.Button({
            style_class: styleClass,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: tooltip,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        btn.connect('notify::hover', () => {
            if (btn.hover)
                this._showTooltip(btn, tooltip);
            else
                this._hideTooltip();
        });
        btn.connect('destroy', () => this._hideTooltip());
        return btn;
    }

    _showTooltip(actor, text) {
        this._hideTooltip();
        const tip = new St.Label({style_class: 'dash-label port-killer-tooltip', text, opacity: 0});
        Main.layoutManager.uiGroup.add_child(tip);
        this._tooltip = tip;

        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const [, tw] = tip.get_preferred_width(-1);
        const [, th] = tip.get_preferred_height(-1);
        const monitor = Main.layoutManager.findMonitorForActor(actor);
        const maxX = monitor.x + monitor.width - tw - 6;
        tip.set_position(
            Math.floor(Math.max(monitor.x + 6, Math.min(x + (w - tw) / 2, maxX))),
            Math.floor(y + h + 6 + th > monitor.y + monitor.height ? y - th - 6 : y + h + 6));
        tip.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _hideTooltip() {
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    async _refresh() {
        const token = ++this._refreshToken;
        try {
            const {ok, out, err} = await run(['ss', '-Htlnp']);
            if (token !== this._refreshToken)
                return;
            this._error = ok ? null : (err.trim() || 'ss falló');
            this._entries = ok ? parseSs(out) : [];
        } catch (e) {
            if (token !== this._refreshToken)
                return;
            this._error = e.message;
            this._entries = [];
        }
        this._render();
    }

    _render() {
        if (!this._section)
            return;
        this._section.removeAll();

        if (this._error) {
            this._section.addMenuItem(new PopupMenu.PopupMenuItem(`Error: ${this._error}`, {reactive: false}));
            return;
        }

        const q = this._search.get_text().trim().toLowerCase();
        const list = this._entries.filter(e => !q ||
            String(e.port).includes(q) ||
            e.names.join(' ').toLowerCase().includes(q) ||
            e.cmd.toLowerCase().includes(q) ||
            e.cwd.toLowerCase().includes(q));

        if (!list.length) {
            const msg = q ? 'Ningún puerto coincide' : 'No tienes procesos escuchando en puertos TCP';
            this._section.addMenuItem(new PopupMenu.PopupMenuItem(msg, {reactive: false}));
            return;
        }

        for (const entry of list)
            this._section.addMenuItem(this._buildRow(entry));
    }

    _buildRow(entry) {
        const item = new PopupMenu.PopupBaseMenuItem({activate: false});

        item.add_child(new St.Label({
            text: `:${entry.port}`,
            style_class: 'port-killer-port',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const info = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'port-killer-info',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = entry.names.join(', ');
        const title = `${entry.project ? `${entry.project} (${name})` : name}  ·  pid ${entry.pids.join(', ')}`;
        const titleLabel = new St.Label({text: title, style_class: 'port-killer-name'});
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(titleLabel);

        const home = GLib.get_home_dir();
        const cwd = entry.cwd.startsWith(home) ? `~${entry.cwd.slice(home.length)}` : entry.cwd;
        const parts = [entry.addrs.join(', ')];
        if (cwd && cwd !== '/')
            parts.push(cwd);
        if (entry.cmd)
            parts.push(entry.cmd.length > 60 ? `${entry.cmd.slice(0, 59)}…` : entry.cmd);
        const sub = new St.Label({text: parts.join('  ·  '), style_class: 'port-killer-sub'});
        sub.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        info.add_child(sub);
        item.add_child(info);

        const openBtn = this._iconButton('web-browser-symbolic', 'port-killer-btn', 'Abrir');
        openBtn.connect('clicked', () => {
            this.menu.close();
            Gio.AppInfo.launch_default_for_uri(`http://localhost:${entry.port}`, null);
        });
        item.add_child(openBtn);

        const killBtn = this._iconButton('media-playback-stop-symbolic', 'port-killer-btn port-killer-kill', 'Detener');
        killBtn.connect('clicked', () => this._kill(entry));
        item.add_child(killBtn);

        return item;
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sources.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(id);
        });
    }

    async _kill(entry) {
        try {
            for (const pid of entry.pids)
                await run(['kill', '-TERM', String(pid)]);
            await this._sleep(KILL_GRACE_MS);
            if (this._destroyed)
                return;
            for (const pid of entry.pids.filter(isAlive))
                await run(['kill', '-KILL', String(pid)]);
        } catch (e) {
            Main.notify('Port Killer', `Error al matar :${entry.port}: ${e.message}`);
        }
        if (!this._destroyed)
            this._refresh();
    }

    destroy() {
        this._destroyed = true;
        GLib.source_remove(this._timer);
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        this._hideTooltip();
        super.destroy();
    }
});

export default class PortKillerExtension extends Extension {
    enable() {
        this._indicator = new PortIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
