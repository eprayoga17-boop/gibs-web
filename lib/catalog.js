"use strict";
/* Salinan katalog dari "GIBS Site.dc.html" (PRODUCTS dan AREAS) untuk validasi di
   server: browser hanya mengirim id produk + jumlah, nama dan satuan diambil dari
   sini, sehingga isi RFQ tidak bisa dipalsukan. Bila katalog di halaman berubah,
   ubah juga file ini; `npm test` memeriksa keduanya masih sama. */

const PRODUCTS = [
  { id: "b1", cat: "besi", name: "Besi polos SNI 6 mm × 12 m", unit: "batang" },
  { id: "b2", cat: "besi", name: "Besi polos HD 8 mm × 12 m SNI", unit: "batang" },
  { id: "b3", cat: "besi", name: "Besi polos HD 10 mm × 12 m SNI", unit: "batang" },
  { id: "b4", cat: "besi", name: "Besi beton 12 mm × 12 m", unit: "batang" },
  { id: "b5", cat: "besi", name: "Besi ulir, ukuran sesuai kebutuhan", unit: "batang" },
  { id: "p1", cat: "pipa", name: "Pipa PVC Rucika", unit: "batang" },
  { id: "p2", cat: "pipa", name: "Fitting PVC Rucika: elbow, tee, sock", unit: "pcs" },
  { id: "k1", cat: "kayu", name: "Triplek meranti", unit: "lembar" },
  { id: "k2", cat: "kayu", name: "Triplek sengon", unit: "lembar" },
  { id: "s1", cat: "sanitair", name: "Kran air Kranz", unit: "pcs" },
  { id: "s2", cat: "sanitair", name: "Aksesori kamar mandi Kranz", unit: "pcs" },
  { id: "t1", cat: "pengikat", name: "Kawat bendrat Naga Huaxin 20 kg", unit: "roll" },
  { id: "t2", cat: "pengikat", name: "Paku Super Q 2\"", unit: "dus" },
  { id: "t3", cat: "pengikat", name: "Paku Super Q 3\", 30 kg", unit: "dus" },
  { id: "t4", cat: "pengikat", name: "Paku Super Q 4\"", unit: "dus" },
  { id: "t5", cat: "pengikat", name: "Sekrup drilling Dovi", unit: "dus" },
];

const AREAS = {
  "Kota Mataram": ["Ampenan", "Cakranegara", "Mataram", "Sandubaya", "Sekarbela", "Selaparang"],
  "Lombok Barat": ["Batu Layar", "Gerung", "Gunungsari", "Kediri", "Kuripan", "Labuapi", "Lembar", "Lingsar", "Narmada", "Sekotong"],
  "Lombok Tengah": ["Batukliang", "Batukliang Utara", "Janapria", "Jonggat", "Kopang", "Praya", "Praya Barat", "Praya Barat Daya", "Praya Tengah", "Praya Timur", "Pringgarata", "Pujut"],
  "Lombok Timur": ["Aikmel", "Jerowaru", "Keruak", "Labuhan Haji", "Masbagik", "Montong Gading", "Pringgabaya", "Pringgasela", "Sakra", "Sakra Barat", "Sakra Timur", "Sambelia", "Selong", "Sembalun", "Sikur", "Suela", "Sukamulia", "Suralaga", "Terara", "Wanasaba"],
  "Lombok Utara": ["Bayan", "Gangga", "Kayangan", "Pemenang", "Tanjung"],
  "Luar Pulau Lombok": ["Sumbawa, Bima, Dompu", "Lainnya"],
};

module.exports = { PRODUCTS, AREAS };
