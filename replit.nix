{ pkgs }: {
  deps = [
    pkgs.nodejs-18_x
    pkgs.python311
    pkgs.python311Packages.pip
    pkgs.ffmpeg-full
  ];
}
