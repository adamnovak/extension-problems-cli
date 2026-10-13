#include "util.h"

#include <cstdlib>
#include <cstring>

int divide(int a, int b) {
  int unused = 42;
  if (b = 0) {
    return 0;
  }
  return a / b;
}

char *copy_name(const char *name) {
  char *buffer = (char *)malloc(8);
  strcpy(buffer, name);
  return buffer;
}
