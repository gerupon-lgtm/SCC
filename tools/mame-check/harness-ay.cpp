// MAME の ay8910.cpp を、MSX と同じ設定（AY8910、単一出力）でそのまま動かし、出力を記録する（T-110）
// 入力（標準入力）：A <16進>（アドレス、ポート 0xA0）、D <16進>（データ、0xA1）、T <n>（n tick 進める）
// 出力：各 tick の出力（float）を、%.9g で1行ずつ
#include "mame/ay8910.cpp"

#include <iostream>
#include <string>

class harness_psg : public ay8910_device {
public:
	harness_psg() : ay8910_device(machine_config(), "psg", nullptr, 3579545 / 2) {
		set_flags(AY8910_SINGLE_OUTPUT);
		device_start();
		device_reset();
	}
	void run(int n, std::string &out) {
		sound_stream &s = *owned_stream();
		s.begin(n);
		sound_stream_update(s);
		char buf[40];
		for (float v : s.out()) {
			int len = std::snprintf(buf, sizeof buf, "%.9g\n", double(v));
			out.append(buf, len);
		}
	}
};

int main() {
	std::ios::sync_with_stdio(false);
	harness_psg psg;
	std::string line, out;
	while (std::getline(std::cin, line)) {
		if (line.empty() || line[0] == '#') continue;
		unsigned v = 0;
		if (line[0] == 'A') { if (std::sscanf(line.c_str() + 1, "%x", &v) != 1) return 2; psg.address_w(u8(v)); }
		else if (line[0] == 'D') { if (std::sscanf(line.c_str() + 1, "%x", &v) != 1) return 2; psg.data_w(u8(v)); }
		else if (line[0] == 'T') { int n = 0; if (std::sscanf(line.c_str() + 1, "%d", &n) != 1) return 2; psg.run(n, out); }
		else return 2;
	}
	std::fwrite(out.data(), 1, out.size(), stdout);
	return 0;
}
