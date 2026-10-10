// MAME本体の代わりに、k051649.cpp をそのまま動かすための最小の枠（T-006 案A）
// k051649.cpp・k051649.h は MAME のファイルを変更せずに使う。ここで用意するのは、
// それらが参照する型・マクロ・基底クラスだけ。計算の部分には手を入れない
#pragma once

#include <algorithm>
#include <cstdint>
#include <functional>
#include <iterator>
#include <memory>
#include <vector>

using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using s8 = std::int8_t;
using s16 = std::int16_t;
using offs_t = u32;

#define ATTR_COLD
#define BIT(x, n) (((x) >> (n)) & 1)
#define FUNC(x) &x
#define NAME(x) x
#define STRUCT_MEMBER(s, m) s
#define DECLARE_DEVICE_TYPE(Type, Class) extern const int Type;
#define DEFINE_DEVICE_TYPE(Type, Class, Short, Full) const int Type = 0;

struct machine_config {};

struct running_machine {
	bool side_effects_disabled() const { return false; }
};

struct address_space {
	u8 unmap() const { return 0xff; }
};

class device_t;

// 1サンプル分の整数の和を記録する。MAMEの add_int(ch, i, v, range) は v/range を足すが、
// 照合では割り算の前の整数 v の和を比べる（CLAUDE.md 変更禁止事項2）
class sound_stream {
public:
	explicit sound_stream(u32 rate) : m_rate(rate) {}
	int samples() const { return int(m_out.size()); }
	void add_int(int, int i, int v, int range) { m_out[i] += v; m_range = range; }
	void update() {}
	void set_sample_rate(u32 rate) { m_rate = rate; }
	void begin(int n) { m_out.assign(n, 0); }
	const std::vector<long long> &out() const { return m_out; }
	int range() const { return m_range; }
private:
	u32 m_rate;
	int m_range = 0;
	std::vector<long long> m_out;
};

class device_t {
public:
	device_t(const machine_config &, int, const char *, device_t *, u32 clock) : m_clock(clock) {}
	virtual ~device_t() = default;
	u32 clock() const { return m_clock; }
	running_machine &machine() { return m_machine; }
	template <typename T> void save_item(T &&) {}
protected:
	virtual void device_start() {}
	virtual void device_reset() {}
	virtual void device_post_load() {}
	virtual void device_clock_changed() {}
private:
	u32 m_clock;
	running_machine m_machine;
};

class device_sound_interface {
public:
	device_sound_interface(const machine_config &, device_t &) {}
	virtual ~device_sound_interface() = default;
	sound_stream *stream_alloc(int, int, u32 rate) {
		m_stream_owned = std::make_unique<sound_stream>(rate);
		return m_stream_owned.get();
	}
	sound_stream *owned_stream() { return m_stream_owned.get(); }
protected:
	virtual void sound_stream_update(sound_stream &stream) = 0;
private:
	std::unique_ptr<sound_stream> m_stream_owned;
};

// scc_map の割り当てを記録し、アドレスから書き込み関数を呼ぶ
class address_map {
public:
	using write_fn = std::function<void(device_t *, offs_t, u8)>;
	struct entry {
		offs_t start = 0, end = 0, mirror_mask = 0;
		template <typename R, typename W> entry &rw(R, W w_) { return w(w_); }
		template <typename C> entry &w(void (C::*m)(offs_t, u8)) {
			w_fn = [m](device_t *d, offs_t o, u8 v) { (static_cast<C *>(d)->*m)(o, v); };
			return *this;
		}
		template <typename C> entry &w(void (C::*m)(u8)) {
			w_fn = [m](device_t *d, offs_t, u8 v) { (static_cast<C *>(d)->*m)(v); };
			return *this;
		}
		entry &mirror(offs_t m) { mirror_mask = m; return *this; }
		write_fn w_fn;
	};
	entry &operator()(offs_t start, offs_t end) {
		m_entries.push_back(std::make_unique<entry>());
		m_entries.back()->start = start;
		m_entries.back()->end = end;
		return *m_entries.back();
	}
	// 戻り値：書き込み先があったか
	bool write(device_t *d, offs_t addr, u8 v) const {
		for (const auto &e : m_entries) {
			const offs_t a = addr & ~e->mirror_mask;
			if (a >= e->start && a <= e->end && e->w_fn) {
				e->w_fn(d, a - e->start, v);
				return true;
			}
		}
		return false;
	}
private:
	std::vector<std::unique_ptr<entry>> m_entries;
};
