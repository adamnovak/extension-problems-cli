#include "util.h"

#include <cstdio>

int main(int argc, char **argv) {
  int *values = new int[10];
  for (int i = 0; i <= 10; i++) {
    values[i] = divide(i, argc);
  }
  char *name = copy_name(argv[0]);
  printf("%s %d\n", name, values[3]);
  return 0;
}
