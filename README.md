# Port Killer

Extensión de GNOME Shell (49–51) que muestra en el panel los puertos TCP en los que
escuchan **tus procesos** y permite matarlos con un clic.

- Lista cada puerto con el proyecto (carpeta de trabajo), ejecutable, pid y comando.
- Filtro por puerto, proceso o carpeta.
- 🌐 abre `http://localhost:PUERTO` en el navegador.
- ⏹ envía `SIGTERM` y, si el proceso sigue vivo a los 1,5 s, `SIGKILL`.

Los procesos del sistema (root u otros usuarios) no se muestran.

## Instalación

```bash
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/port-killer@camiloeferrera.github.io
gnome-extensions enable port-killer@camiloeferrera.github.io
```

En Wayland hay que cerrar sesión y volver a entrar para que GNOME detecte la extensión
y para recargar cambios en el código.

Requiere `ss` (iproute2).

Para generar el paquete que se sube a extensions.gnome.org:

```bash
mkdir -p dist && gnome-extensions pack --force --extra-source=icons --out-dir=dist .
```

## Licencia

GPL-2.0-or-later
