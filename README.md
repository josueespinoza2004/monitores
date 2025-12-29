# Monitores — Minimal Uptime-Kuma-like App

Proyecto mínimo para ejecutar monitores (HTTP) en entornos como cPanel.

Requisitos
- Node.js 14+ (si cPanel ofrece Node.js App Manager)

Instalación
```bash
cd monitores
npm ci
npm start
```

Despliegue en cPanel
- Use "Application Manager" (si disponible) y apunte a esta carpeta, comando `npm start`.
- Si no hay soporte Node, se puede ejecutar en un VPS o convertir la lógica a PHP.

Notas
- Almacenamiento simple en `data/monitors.json` (no subir `data/` a git).
- Este proyecto es una base; para producción añada autenticación, HTTPS, robustez y checks de TCP.

Licencia: MIT
