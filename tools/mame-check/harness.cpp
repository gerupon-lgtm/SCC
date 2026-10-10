// MAMEの k051649.cpp を、そのまま動かして出力を記録する（T-006 案A）
// 入力（標準入力、1行1命令）：
//   W <addr16進> <value16進>   scc_map のアドレスへ書き込む
//   T <n>                      nクロック進める。各クロックの出力（整数）を1行ずつ書き出す
// 出力（標準出力）：各クロックの整数（sample>>4 の和）
#include "mame/k051649.cpp"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>

class harness_device : public k051649_device {
public:
	harness_device() : k051649_device(machine_config(), "scc", nullptr, 3579545) {
		scc_map(m_map);
		device_start();
		device_reset();
	}
	void write(offs_t addr, u8 v) {
		if (!m_map.write(this, addr, v)) { /* 割り当てのないアドレスは何もしない */ }
	}
	void run(int n, std::string &out) {
		sound_stream &s = *owned_stream();
		s.begin(n);
		sound_stream_update(s);
		char buf[32];
		for (long long v : s.out()) {
			int len = std::snprintf(buf, sizeof buf, "%lld\n", v);
			out.append(buf, len);
		}
		if (s.range() != 0 && s.range() != 1024) std::fprintf(stderr, "unexpected range %d\n", s.range());
	}
private:
	address_map m_map;
};

int main() {
	std::ios::sync_with_stdio(false);
	harness_device dev;
	std::string line, out;
	while (std::getline(std::cin, line)) {
		if (line.empty() || line[0] == '#') continue;
		if (line[0] == 'W') {
			unsigned a = 0, v = 0;
			if (std::sscanf(line.c_str() + 1, "%x %x", &a, &v) != 2) return 2;
			dev.write(a, u8(v));
		} else if (line[0] == 'T') {
			int n = 0;
			if (std::sscanf(line.c_str() + 1, "%d", &n) != 1 || n < 0) return 2;
			dev.run(n, out);
		} else {
			return 2;
		}
	}
	std::fwrite(out.data(), 1, out.size(), stdout);
	return 0;
}
