#include <fcntl.h>
/* fcntl is variadic, which plain FFI declarations cannot call safely on arm64. */
int set_cloexec(int fd) { return fcntl(fd, F_SETFD, FD_CLOEXEC); }
