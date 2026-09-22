# Read by dmgbuild; the package script supplies absolute paths via -D.
#
# The window is a picture with two icons seated in it, not a white rectangle
# with two icons loose in it. `Tools/DMGBackground.swift` draws the picture from
# the app's own mark and palette, and the positions below are the same numbers
# that tool lays out from, so the art and the icons cannot drift apart.
app = defines["app"]
files = [app, defines["instructions"]]
symlinks = {"Applications": "/Applications"}
format = "UDZO"
filesystem = "HFS+"
volume_name = "Install VibeWire"
# The volume's own icon, so the thing on the desktop and in the sidebar is the
# app's mark rather than the generic white disk.
icon = defines["volume_icon"]
window_rect = ((200, 140), (660, 500))
background = defines["background"]
default_view = "icon-view"
show_toolbar = False
show_status_bar = False
show_sidebar = False
show_item_info = False
show_icon_preview = False
icon_size = 96
text_size = 13
icon_locations = {
    "VibeWire.app": (175, 206),
    "Applications": (485, 206),
    "Start here.txt": (330, 368),
}
# Do not add FinderInfo to the signed app: that invalidates strict verification.
hide_extensions = []
