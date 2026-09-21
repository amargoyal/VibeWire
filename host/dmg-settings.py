# Read by dmgbuild; the package script supplies absolute paths via -D.
app = defines["app"]
files = [app, defines["instructions"]]
symlinks = {"Applications": "/Applications"}
format = "UDZO"
filesystem = "HFS+"
volume_name = "Install VibeWire"
window_rect = ((200, 160), (600, 400))
background = "#f5f5f7"
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_sidebar = False
icon_size = 96
text_size = 14
icon_locations = {
    "VibeWire.app": (160, 140),
    "Applications": (440, 140),
    "Start here.txt": (300, 300),
}
hide_extensions = ["VibeWire.app"]
