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
# The size here is the whole window, and the background fills the content area
# underneath the title bar. Sized to the artwork exactly, Finder is left with a
# content area 28 points shorter than the picture, decides there is more to see,
# and puts a scroll bar along the bottom of the installer.
window_rect = ((200, 120), (660, 548))
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
    "Start here.txt": (586, 376),
}
# Do not add FinderInfo to the signed app: that invalidates strict verification.
hide_extensions = []
